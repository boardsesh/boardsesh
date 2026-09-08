/// <reference types="node" />

/**
 * The screenshot backend: one local HTTP + WebSocket server that either RECORDS
 * what PROD answered for a capture run, or REPLAYS those recordings so the App
 * Store screenshots are byte-deterministic.
 *
 * Why a proxy rather than a seeded database: the store capture shoots the real
 * app against the real backend contract, so anything that changes what the
 * server sends — a resolver, a rollout, someone else's tick landing in a shared
 * feed — moves the pixels. Recording the exact bodies once and replaying them
 * makes the capture a pure function of the JS bundle.
 *
 * All the keying, manifest shape and log grammar live in the pure sibling
 * module (screenshot-fixtures.ts); this file is the I/O.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { extname, join, resolve as resolvePath, sep } from 'node:path';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';

import {
  FIXTURE_HASH_DISPLAY_LENGTH,
  FIXTURE_SIZE_NOTE_BYTES,
  RE_RECORD_COMMAND,
  SCREENSHOT_FIXTURE_FORMAT_VERSION,
  STATIC_KEY_LENGTH,
  VARIANT_COUNT_NOTE_THRESHOLD,
  emptyManifest,
  findSensitiveVariableKeys,
  fixtureSizeNote,
  formatScreenshotBackendLine,
  graphqlFixtureKey,
  redactIgnoredVariablePaths,
  resolveOperationName,
  sortManifestEntries,
  sortedQueryString,
  staticFixtureKey,
  validateScreenshotFixtureManifest,
  variantCountNote,
  type GraphqlFixtureFile,
  type GraphqlManifestEntry,
  type ScreenshotBackendLogLine,
  type ScreenshotBackendMode,
  type ScreenshotFixtureManifest,
  type StaticManifestEntry,
} from './screenshot-fixtures';

export type ScreenshotBackendServerOptions = {
  mode: ScreenshotBackendMode;
  fixturesDir: string;
  /** The backend to record from. Always null in replay mode — replay makes no outbound request. */
  upstreamUrl: string | null;
  /** The instant the capture pretends it is. Recorded into the manifest, echoed in READY. */
  frozenNow: string;
  log: (line: string) => void;
  /** Record only: throw away the existing fixture set instead of extending it. */
  fresh?: boolean;
  /** Which capture flow is being recorded. Stored in the manifest for provenance. */
  flow?: string;
};

export type ScreenshotBackendStats = {
  mode: ScreenshotBackendMode;
  hits: number;
  misses: number;
  recorded: number;
  /** Fixtures refused because they carried a live auth token. Non-zero fails the run. */
  redacted: number;
  fixtures: { graphql: number; static: number };
};

export type ScreenshotBackendServer = {
  /** Binds 0.0.0.0 and resolves with the actual port (pass 0 for an ephemeral one). */
  listen(port: number): Promise<number>;
  close(): Promise<void>;
  stats(): ScreenshotBackendStats;
};

export const MANIFEST_FILENAME = 'manifest.json';
export const DEFAULT_SCREENSHOT_FLOW = 'app-store';

/** The synthetic refresh token replay hands out. Constant, and never a real credential. */
export const REPLAY_REFRESH_TOKEN = 'screenshot-replay-refresh';

/**
 * The synthetic jwt replay hands out is a REAL jwt SHAPE — three base64url
 * segments — because the app decodes its own token to learn who it is
 * (`userIdFromJwt`, packages/mobile/src/lib/jwt-user-id.ts) and a token with
 * anything but three segments reads as "no id". It is not signed and never
 * could be: `alg: none`, a fixed literal where a signature would go, and the
 * recorded `accountUserId` as its subject.
 */
const REPLAY_JWT_HEADER_JSON = '{"alg":"none","typ":"JWT"}';
const REPLAY_JWT_ISSUER = 'screenshot-replay';
const REPLAY_JWT_SIGNATURE = 'screenshot-replay';
/**
 * Comfortably longer than the app's own 24h `isTokenExpiringSoon` threshold
 * (`packages/mobile/src/lib/auth-store.ts`). A replay session used to be
 * stamped with exactly that threshold, which meant every request computed an
 * `expiresAt` that read as "expiring soon" the instant it was checked and put
 * the capture into a refresh loop — the opposite of what the comment here
 * used to claim.
 */
const REPLAY_SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

// Hop-by-hop and body-framing headers: forwarding them to `fetch` either throws
// or makes the upstream frame a body we already buffered.
const UNFORWARDABLE_HEADERS = new Set([
  'host',
  'content-length',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'accept-encoding',
]);

const CONTENT_TYPE_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
  'application/json': 'json',
  'text/plain': 'txt',
};

/** A ws frame as text. `RawData` is a Buffer, an ArrayBuffer, or a list of Buffers. */
function rawFrameText(frame: RawData): string {
  if (Array.isArray(frame)) return Buffer.concat(frame).toString('utf8');
  if (Buffer.isBuffer(frame)) return frame.toString('utf8');
  return Buffer.from(frame).toString('utf8');
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function base64Url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

/**
 * The `sub` claim of a jwt, decoded WITHOUT verifying anything.
 *
 * Deliberately a small reimplementation of `userIdFromJwt`
 * (packages/mobile/src/lib/jwt-user-id.ts) rather than an import: a build
 * script must not reach into the mobile app's source graph. The rules it has to
 * agree on are only these two — exactly three dot-separated segments, and a
 * `sub` string in the base64url-encoded middle one.
 */
export function jwtSubject(token: string): string | null {
  const segments = token.split('.');
  if (segments.length !== 3) return null;
  try {
    const payload: unknown = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8'));
    if (typeof payload !== 'object' || payload === null) return null;
    const subject = (payload as { sub?: unknown }).sub;
    return typeof subject === 'string' && subject.length > 0 ? subject : null;
  } catch {
    return null;
  }
}

function shortHash(hash: string): string {
  return hash.slice(0, FIXTURE_HASH_DISPLAY_LENGTH);
}

/** Read a manifest off disk. Returns null when there is none; throws when there is a broken one. */
export function readScreenshotFixtureManifest(fixturesDir: string): ScreenshotFixtureManifest | null {
  const manifestPath = join(fixturesDir, MANIFEST_FILENAME);
  if (!existsSync(manifestPath)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (parseError) {
    const detail = parseError instanceof Error ? parseError.message : String(parseError);
    throw new Error(`${manifestPath} is not valid JSON: ${detail}`);
  }
  const validation = validateScreenshotFixtureManifest(parsed);
  if (!validation.ok) throw new Error(`${manifestPath} is not a usable fixture manifest: ${validation.reason}`);
  return validation.manifest;
}

function writeJsonFile(filePath: string, value: unknown): void {
  mkdirSync(join(filePath, '..'), { recursive: true });
  const temporaryPath = `${filePath}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(temporaryPath, filePath);
}

async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function forwardableHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const forwarded: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(headers)) {
    if (headerValue === undefined) continue;
    if (UNFORWARDABLE_HEADERS.has(name.toLowerCase())) continue;
    forwarded[name] = Array.isArray(headerValue) ? headerValue.join(', ') : headerValue;
  }
  return forwarded;
}

/** Writes an already-serialized JSON string, so a cached body is sent without re-stringifying it. */
function sendRawJson(response: ServerResponse, status: number, jsonText: string): void {
  const encoded = Buffer.from(jsonText, 'utf8');
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': encoded.length });
  response.end(encoded);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  sendRawJson(response, status, JSON.stringify(body));
}

function parseJsonBody(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    return null;
  }
}

/** The GraphQL body a replay miss answers with. 200, NEVER a 5xx — see the note in `handleGraphql`. */
function fixtureMissBody(operationName: string, hash12: string): unknown {
  return {
    errors: [
      {
        message: `screenshot fixture miss: ${operationName} ${hash12}`,
        extensions: { code: 'SCREENSHOT_FIXTURE_MISS' },
      },
    ],
  };
}

function assetExtension(contentType: string, pathname: string): string {
  const baseType = contentType.split(';')[0].trim().toLowerCase();
  if (Object.hasOwn(CONTENT_TYPE_EXTENSIONS, baseType)) return CONTENT_TYPE_EXTENSIONS[baseType];
  const fromPath = extname(pathname).replace('.', '');
  return fromPath.length > 0 ? fromPath.toLowerCase() : 'bin';
}

/**
 * On disk a graphql fixture is keyed on `STATIC_KEY_LENGTH` (16) hex
 * characters of the variables hash, matching the static asset key length. Log
 * lines stay at the shorter `FIXTURE_HASH_DISPLAY_LENGTH` (12) — this is the
 * only thing that reads the longer prefix.
 */
function graphqlFixturePath(operationName: string, variablesHash: string): string {
  return `graphql/${operationName}/${variablesHash.slice(0, STATIC_KEY_LENGTH)}.json`;
}

/**
 * True when a fixture's recorded `file`, resolved against the fixtures
 * directory, cannot escape it. `validateScreenshotFixtureManifest` already
 * rejects a `file` shaped like an escape at manifest-load time; this is the
 * belt to that validator's braces, checked again immediately before the bytes
 * are read off disk.
 */
export function isFixtureFileWithinDirectory(fixturesDir: string, file: string): boolean {
  const resolvedFixturesDir = resolvePath(fixturesDir);
  const resolvedFile = resolvePath(fixturesDir, file);
  return resolvedFile === resolvedFixturesDir || resolvedFile.startsWith(`${resolvedFixturesDir}${sep}`);
}

export function createScreenshotBackend(options: ScreenshotBackendServerOptions): ScreenshotBackendServer {
  const { mode, fixturesDir, frozenNow, log } = options;
  const isRecording = mode === 'record';
  const upstreamUrl = isRecording ? (options.upstreamUrl ?? '').replace(/\/+$/, '') : null;
  if (isRecording && !upstreamUrl) throw new Error('record mode needs an --upstream to record from');
  if (!isRecording && options.upstreamUrl) {
    throw new Error('replay mode makes no outbound requests — drop --upstream');
  }

  const emit = (line: ScreenshotBackendLogLine): void => log(formatScreenshotBackendLine(line));

  if (isRecording && options.fresh) {
    // Bounded on purpose: only the two subtrees this server owns plus its
    // manifest, never the directory the caller pointed at.
    rmSync(join(fixturesDir, 'graphql'), { recursive: true, force: true });
    rmSync(join(fixturesDir, 'static'), { recursive: true, force: true });
    rmSync(join(fixturesDir, MANIFEST_FILENAME), { force: true });
  }

  const loadedManifest = readScreenshotFixtureManifest(fixturesDir);
  if (!isRecording && !loadedManifest) {
    throw new Error(`replay needs a recorded fixture set — no ${MANIFEST_FILENAME} under ${fixturesDir}`);
  }
  const manifest =
    loadedManifest ??
    emptyManifest({
      recordedAt: new Date().toISOString(),
      frozenNow,
      upstream: upstreamUrl ?? '',
      accountEmail: '',
      accountUserId: '',
      flow: options.flow ?? DEFAULT_SCREENSHOT_FLOW,
    });
  if (isRecording) {
    manifest.recordedAt = new Date().toISOString();
    manifest.frozenNow = frozenNow;
    manifest.upstream = upstreamUrl ?? '';
    manifest.flow = options.flow ?? manifest.flow;
  }

  // (operationName, variablesHash) -> entry. The variables pick the fixture; the
  // recorded documentHash then says whether the app's query still matches.
  const graphqlIndex = new Map<string, GraphqlManifestEntry>();
  for (const entry of manifest.graphql) graphqlIndex.set(`${entry.operationName}\n${entry.variablesHash}`, entry);
  const staticIndex = new Map<string, StaticManifestEntry>();
  for (const entry of manifest.static)
    staticIndex.set(entry.query ? `${entry.path}?${entry.query}` : entry.path, entry);

  const variantCounts = new Map<string, number>();
  for (const entry of manifest.graphql) {
    variantCounts.set(entry.operationName, (variantCounts.get(entry.operationName) ?? 0) + 1);
  }

  /**
   * Live tokens seen on a proxied auth response, kept IN MEMORY ONLY. Every
   * fixture is checked against these before it is written: a screenshot fixture
   * set is committed to the repo, and one leaked jwt would be a credential in
   * git history.
   */
  const sensitiveTokens = new Set<string>();

  let hits = 0;
  let misses = 0;
  let recorded = 0;
  let redacted = 0;

  /**
   * Replay only: `entry.file` -> its response, already serialized. A hot
   * fixture (e.g. SearchClimbs, requested on every keystroke) is read and
   * JSON.parsed once per process, not once per request. Nothing ever
   * invalidates it — replay makes no writes, so the file behind an entry
   * cannot change out from under the cache during a run.
   */
  const replayResponseCache = new Map<string, string>();

  const rewriteManifest = (): void => {
    writeJsonFile(join(fixturesDir, MANIFEST_FILENAME), sortManifestEntries(manifest));
  };

  const carriesSensitiveToken = (serialized: string): boolean => {
    for (const token of sensitiveTokens) {
      // Short values would false-positive against ordinary content; a real jwt
      // or refresh token is far longer than this.
      if (token.length >= 8 && serialized.includes(token)) return true;
    }
    return false;
  };

  // -------------------------------------------------------------------------
  // POST /graphql
  // -------------------------------------------------------------------------

  const recordGraphql = async (
    request: IncomingMessage,
    response: ServerResponse,
    rawBody: Buffer,
    parsedBody: Record<string, unknown>,
  ): Promise<void> => {
    const upstreamResponse = await fetch(`${upstreamUrl}/graphql`, {
      method: 'POST',
      headers: { ...forwardableHeaders(request.headers), 'content-type': 'application/json' },
      // Sent as text, not the Buffer: both bodies here are JSON, and `fetch`'s
      // BodyInit does not accept a Node Buffer under the DOM lib.
      body: rawBody.toString('utf8'),
    });
    const responseText = await upstreamResponse.text();
    const contentType = upstreamResponse.headers.get('content-type') ?? 'application/json; charset=utf-8';
    response.writeHead(upstreamResponse.status, {
      'content-type': contentType,
      'content-length': Buffer.byteLength(responseText),
    });
    response.end(responseText);

    const operationName = resolveOperationName(parsedBody);
    const loggedName = operationName ?? 'anonymous';
    const responseBody: unknown = ((): unknown => {
      try {
        return JSON.parse(responseText);
      } catch {
        return null;
      }
    })();

    const hasInternalServerError =
      typeof responseBody === 'object' &&
      responseBody !== null &&
      Array.isArray((responseBody as { errors?: unknown }).errors) &&
      (responseBody as { errors: unknown[] }).errors.some(
        (graphqlError) =>
          typeof graphqlError === 'object' &&
          graphqlError !== null &&
          (graphqlError as { extensions?: { code?: unknown } }).extensions?.code === 'INTERNAL_SERVER_ERROR',
      );
    const hasData = typeof responseBody === 'object' && responseBody !== null && Object.hasOwn(responseBody, 'data');

    if (upstreamResponse.status !== 200 || !hasData || hasInternalServerError) {
      emit({
        event: 'upstream-error',
        operationName: loggedName,
        detail: hasInternalServerError ? 'code=INTERNAL_SERVER_ERROR' : `status=${upstreamResponse.status}`,
      });
      return;
    }
    if (!operationName) {
      // Nothing to file it under, and a nameless document cannot be looked up on
      // replay either. Report it as an upstream-shaped problem so it surfaces.
      emit({ event: 'upstream-error', operationName: loggedName, detail: 'status=200' });
      return;
    }

    const query = typeof parsedBody.query === 'string' ? parsedBody.query : '';
    const key = graphqlFixtureKey({ operationName, query, variables: parsedBody.variables }, sha256Hex);
    const indexKey = `${key.operationName}\n${key.variablesHash}`;
    if (graphqlIndex.has(indexKey)) {
      // FIRST WINS. A capture calls the same query many times; re-recording on
      // every call would make the fixture set depend on scroll timing.
      emit({ event: 'duplicate', operationName: key.operationName, hash12: shortHash(key.variablesHash) });
      return;
    }

    const fixture: GraphqlFixtureFile = {
      formatVersion: SCREENSHOT_FIXTURE_FORMAT_VERSION,
      operationName: key.operationName,
      documentHash: key.documentHash,
      variablesHash: key.variablesHash,
      query,
      // Ignored paths are hashed out of the key above AND redacted here: the
      // Live Activity's push token is a per-run APNs value the key already
      // ignores, so persisting it would put a client credential in the repo for
      // nothing — while dropping the variable outright would hide what the app
      // actually sends.
      variables: redactIgnoredVariablePaths(key.operationName, parsedBody.variables ?? {}),
      response: responseBody,
      status: upstreamResponse.status,
      recordedAt: new Date().toISOString(),
      upstream: upstreamUrl ?? '',
    };
    // A board-login mutation carries the climber's Aurora password as an
    // ordinary GraphQL variable, not a header — `carriesSensitiveToken` below
    // only ever sees a header-derived jwt/refresh token, so this is the check
    // that actually catches it before the fixture reaches disk. Run on the
    // REDACTED variables, so an ignored path that was already replaced no
    // longer refuses the fixture but every other secret-shaped key still does.
    const sensitiveVariableKeys = findSensitiveVariableKeys(fixture.variables);
    if (sensitiveVariableKeys.length > 0) {
      redacted += 1;
      emit({ event: 'redacted', operationName: key.operationName });
      return;
    }

    const serialized = JSON.stringify(fixture);
    if (carriesSensitiveToken(serialized)) {
      redacted += 1;
      emit({ event: 'redacted', operationName: key.operationName });
      return;
    }
    // The bytes actually written (writeJsonFile pretty-prints with a 2-space
    // indent), not the compact string above — a fixture can clear the compact
    // length and still land over budget once it hits disk.
    const writtenBytes = Buffer.byteLength(JSON.stringify(fixture, null, 2));
    if (writtenBytes > FIXTURE_SIZE_NOTE_BYTES) {
      emit({ event: 'note', operationName: key.operationName, note: fixtureSizeNote(writtenBytes) });
    }

    const relativeFile = graphqlFixturePath(key.operationName, key.variablesHash);
    writeJsonFile(join(fixturesDir, relativeFile), fixture);
    const entry: GraphqlManifestEntry = {
      operationName: key.operationName,
      documentHash: key.documentHash,
      variablesHash: key.variablesHash,
      file: relativeFile,
    };
    manifest.graphql.push(entry);
    graphqlIndex.set(indexKey, entry);
    recorded += 1;
    emit({
      event: 'recorded',
      kind: 'graphql',
      operationName: key.operationName,
      hash12: shortHash(key.variablesHash),
      file: relativeFile,
    });

    const variantCount = (variantCounts.get(key.operationName) ?? 0) + 1;
    variantCounts.set(key.operationName, variantCount);
    if (variantCount > VARIANT_COUNT_NOTE_THRESHOLD) {
      emit({ event: 'note', operationName: key.operationName, note: variantCountNote(variantCount) });
    }
    rewriteManifest();
  };

  const replayGraphql = (response: ServerResponse, parsedBody: Record<string, unknown>): void => {
    const operationName = resolveOperationName(parsedBody);
    const query = typeof parsedBody.query === 'string' ? parsedBody.query : '';
    const key = graphqlFixtureKey(
      { operationName: operationName ?? '', query, variables: parsedBody.variables },
      sha256Hex,
    );
    const hash12 = shortHash(key.variablesHash);

    if (!operationName) {
      misses += 1;
      emit({ event: 'miss', kind: 'graphql', operationName: 'anonymous', hash12, reason: 'anonymous-operation' });
      sendJson(response, 200, fixtureMissBody('anonymous', hash12));
      return;
    }

    const entry = graphqlIndex.get(`${operationName}\n${key.variablesHash}`);
    if (!entry) {
      misses += 1;
      emit({ event: 'miss', kind: 'graphql', operationName, hash12, reason: 'no-fixture' });
      sendJson(response, 200, fixtureMissBody(operationName, hash12));
      return;
    }
    if (entry.documentHash !== key.documentHash) {
      misses += 1;
      emit({ event: 'miss', kind: 'graphql', operationName, hash12, reason: 'document-changed' });
      sendJson(response, 200, fixtureMissBody(operationName, hash12));
      return;
    }
    if (!isFixtureFileWithinDirectory(fixturesDir, entry.file)) {
      // Defense in depth: the manifest validator already refuses to load an
      // entry shaped like this, so reaching here means something wrote past
      // that check. Answer exactly like a fixture that was never recorded —
      // never follow the path.
      misses += 1;
      emit({ event: 'miss', kind: 'graphql', operationName, hash12, reason: 'no-fixture' });
      sendJson(response, 200, fixtureMissBody(operationName, hash12));
      return;
    }

    let serializedResponse = replayResponseCache.get(entry.file);
    if (serializedResponse === undefined) {
      try {
        const fixture = JSON.parse(readFileSync(join(fixturesDir, entry.file), 'utf8')) as GraphqlFixtureFile;
        // The recorded body verbatim, `errors` included: a screen that was
        // recorded showing a partial error must screenshot the same way.
        serializedResponse = JSON.stringify(fixture.response);
      } catch {
        // The startup check already read every fixture, so the file went
        // missing or was truncated DURING the run. Answer exactly like any
        // other miss — a 500 here would flip the app into "backend
        // unreachable" and bury the problem under a connectivity banner.
        misses += 1;
        emit({ event: 'miss', kind: 'graphql', operationName, hash12, reason: 'unreadable-fixture' });
        sendJson(response, 200, fixtureMissBody(operationName, hash12));
        return;
      }
      replayResponseCache.set(entry.file, serializedResponse);
    }
    hits += 1;
    emit({ event: 'hit', kind: 'graphql', operationName, hash12 });
    sendRawJson(response, 200, serializedResponse);
  };

  const handleGraphql = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const rawBody = await readRequestBody(request);
    const parsedBody = parseJsonBody(rawBody);
    if (Array.isArray(parsedBody)) {
      // graphql-request never batches, so an array means something else is
      // talking to us and its traffic was never recorded.
      misses += 1;
      emit({ event: 'miss', kind: 'route', method: 'POST', path: '/graphql (batched)' });
      sendJson(response, 400, { errors: [{ message: 'screenshot backend does not serve batched GraphQL requests' }] });
      return;
    }
    if (typeof parsedBody !== 'object' || parsedBody === null) {
      misses += 1;
      emit({ event: 'miss', kind: 'route', method: 'POST', path: '/graphql (unparseable)' });
      sendJson(response, 400, { errors: [{ message: 'screenshot backend could not parse the GraphQL body' }] });
      return;
    }
    // NOTE: every miss below answers 200 with a GraphQL `errors` array, never a
    // 5xx or an INTERNAL_SERVER_ERROR extension — those are what flip the
    // app's connectivity store into "backend unreachable"
    // (packages/mobile/src/lib/graphql/client.ts) and swap every screen for
    // the connectivity banner. A 200 miss instead makes graphql-request throw
    // a ClientError, which React Query reports as an errored query;
    // deriveOfflineQueryState (packages/mobile/src/hooks/use-offline-query-state.ts)
    // then renders that screen's own OfflineState placard with reason `error`
    // — not an empty list. The placard stays visible in the capture, which is
    // exactly what makes a miss noticeable at a glance, and the connectivity
    // store itself is never tripped.
    if (isRecording) await recordGraphql(request, response, rawBody, parsedBody as Record<string, unknown>);
    else replayGraphql(response, parsedBody as Record<string, unknown>);
  };

  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------

  const syntheticSession = (): { jwt: string; refreshToken: string; expiresAt: string } => {
    // Deliberately real wall-clock, not frozenNow: the app refreshes on an
    // expiry it computes itself, and a frozen (long past) expiry would send it
    // into a refresh loop for the whole capture. See REPLAY_SESSION_LIFETIME_MS
    // for why the lifetime itself also has to clear the app's own threshold.
    const expiresAt = new Date(Date.now() + REPLAY_SESSION_LIFETIME_MS);
    const claims = JSON.stringify({
      sub: manifest.accountUserId,
      iss: REPLAY_JWT_ISSUER,
      exp: Math.floor(expiresAt.getTime() / 1000),
    });
    return {
      // Three segments, so the app's own unverified decode finds the recorded
      // user id instead of reading the session as "no id".
      jwt: `${base64Url(REPLAY_JWT_HEADER_JSON)}.${base64Url(claims)}.${REPLAY_JWT_SIGNATURE}`,
      refreshToken: REPLAY_REFRESH_TOKEN,
      expiresAt: expiresAt.toISOString(),
    };
  };

  const recordAuth = async (
    request: IncomingMessage,
    response: ServerResponse,
    rawBody: Buffer,
    pathname: string,
  ): Promise<void> => {
    const upstreamResponse = await fetch(`${upstreamUrl}${pathname}`, {
      method: 'POST',
      headers: { ...forwardableHeaders(request.headers), 'content-type': 'application/json' },
      // Sent as text, not the Buffer: both bodies here are JSON, and `fetch`'s
      // BodyInit does not accept a Node Buffer under the DOM lib.
      body: rawBody.toString('utf8'),
    });
    const responseText = await upstreamResponse.text();
    response.writeHead(upstreamResponse.status, {
      'content-type': upstreamResponse.headers.get('content-type') ?? 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(responseText),
    });
    response.end(responseText);

    if (!upstreamResponse.ok) return;
    const session = parseJsonBody(Buffer.from(responseText, 'utf8'));
    if (typeof session !== 'object' || session === null) return;
    // Held in memory so no fixture can be written carrying them. NEVER persisted.
    for (const field of ['jwt', 'refreshToken'] as const) {
      const token = (session as Record<string, unknown>)[field];
      if (typeof token === 'string' && token.length > 0) sensitiveTokens.add(token);
    }
    const requestBody = parseJsonBody(rawBody);
    const email =
      typeof requestBody === 'object' && requestBody !== null ? (requestBody as { email?: unknown }).email : undefined;
    let manifestChanged = false;
    if (typeof email === 'string' && email.length > 0 && manifest.accountEmail !== email) {
      manifest.accountEmail = email;
      manifestChanged = true;
    }
    // The id, not the token: replay needs a jwt the app can read a `sub` out
    // of, and the live jwt itself must never reach disk. `/auth/native/refresh`
    // carries no email but does carry a jwt, so it fills this in too.
    const liveJwt = (session as Record<string, unknown>).jwt;
    const subject = typeof liveJwt === 'string' ? jwtSubject(liveJwt) : null;
    if (subject && manifest.accountUserId !== subject) {
      manifest.accountUserId = subject;
      manifestChanged = true;
    }
    if (manifestChanged) rewriteManifest();
  };

  const replayCredentials = (response: ServerResponse, rawBody: Buffer): void => {
    const requestBody = parseJsonBody(rawBody);
    const email =
      typeof requestBody === 'object' && requestBody !== null ? (requestBody as { email?: unknown }).email : undefined;
    const submitted = typeof email === 'string' ? email : '';
    if (submitted.trim().toLowerCase() !== manifest.accountEmail.trim().toLowerCase()) {
      misses += 1;
      emit({ event: 'miss', kind: 'auth', email: submitted || '(none)', expectedEmail: manifest.accountEmail });
      sendJson(response, 401, { error: 'screenshot fixtures were recorded for a different account' });
      return;
    }
    hits += 1;
    emit({ event: 'hit', kind: 'auth', route: 'credentials' });
    sendJson(response, 200, syntheticSession());
  };

  // -------------------------------------------------------------------------
  // GET /static/*
  // -------------------------------------------------------------------------

  const recordStatic = async (response: ServerResponse, pathname: string, query: string): Promise<void> => {
    const subject = query ? `${pathname}?${query}` : pathname;
    // PROD answers /static/* with a 302 to a CDN. Follow it for the bytes, but
    // key by what the app asked for — the CDN URL is not stable.
    const upstreamResponse = await fetch(`${upstreamUrl}${subject}`, { redirect: 'follow' });
    const bytes = Buffer.from(await upstreamResponse.arrayBuffer());
    const contentType = upstreamResponse.headers.get('content-type') ?? 'application/octet-stream';
    response.writeHead(upstreamResponse.status, { 'content-type': contentType, 'content-length': bytes.length });
    response.end(bytes);
    if (!upstreamResponse.ok) return;
    if (staticIndex.has(subject)) return;

    const key = staticFixtureKey(pathname, new URLSearchParams(query), sha256Hex);
    const relativeFile = `static/${key}.${assetExtension(contentType, pathname)}`;
    mkdirSync(join(fixturesDir, 'static'), { recursive: true });
    writeFileSync(join(fixturesDir, relativeFile), bytes);
    const entry: StaticManifestEntry = { path: pathname, query, file: relativeFile, contentType, bytes: bytes.length };
    manifest.static.push(entry);
    staticIndex.set(subject, entry);
    recorded += 1;
    emit({ event: 'recorded', kind: 'static', subject, file: relativeFile });
    rewriteManifest();
  };

  const replayStatic = (response: ServerResponse, pathname: string, query: string): void => {
    const subject = query ? `${pathname}?${query}` : pathname;
    const entry = staticIndex.get(subject);
    if (!entry) {
      misses += 1;
      emit({ event: 'miss', kind: 'static', subject });
      sendJson(response, 404, { error: `no recorded asset for ${subject}` });
      return;
    }
    if (!isFixtureFileWithinDirectory(fixturesDir, entry.file)) {
      // Same belt-and-braces as the graphql path: answer like nothing was
      // ever recorded rather than trust an entry.file the validator should
      // already have refused to load.
      misses += 1;
      emit({ event: 'miss', kind: 'static', subject });
      sendJson(response, 404, { error: `no recorded asset for ${subject}` });
      return;
    }
    let bytes: Buffer;
    try {
      bytes = readFileSync(join(fixturesDir, entry.file));
    } catch {
      // Deleted or truncated after the startup check — a miss, not a 500.
      misses += 1;
      emit({ event: 'miss', kind: 'static', subject });
      sendJson(response, 404, { error: `no recorded asset for ${subject}` });
      return;
    }
    hits += 1;
    emit({ event: 'hit', kind: 'static', subject });
    response.writeHead(200, { 'content-type': entry.contentType, 'content-length': bytes.length });
    response.end(bytes);
  };

  // -------------------------------------------------------------------------
  // Routing
  // -------------------------------------------------------------------------

  const currentStats = (): ScreenshotBackendStats => ({
    mode,
    hits,
    misses,
    recorded,
    redacted,
    fixtures: { graphql: manifest.graphql.length, static: manifest.static.length },
  });

  const route = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const requestUrl = new URL(request.url ?? '/', 'http://screenshot-backend.local');
    const pathname = requestUrl.pathname;
    const method = request.method ?? 'GET';

    if (method === 'POST' && pathname === '/graphql') {
      await handleGraphql(request, response);
      return;
    }
    if (method === 'POST' && (pathname === '/auth/native/credentials' || pathname === '/auth/native/refresh')) {
      const rawBody = await readRequestBody(request);
      if (isRecording) await recordAuth(request, response, rawBody, pathname);
      else if (pathname === '/auth/native/credentials') replayCredentials(response, rawBody);
      else {
        hits += 1;
        emit({ event: 'hit', kind: 'auth', route: 'refresh' });
        sendJson(response, 200, syntheticSession());
      }
      return;
    }
    if (method === 'GET' && pathname.startsWith('/static/')) {
      const query = sortedQueryString(requestUrl.searchParams);
      if (isRecording) await recordStatic(response, pathname, query);
      else replayStatic(response, pathname, query);
      return;
    }
    if (method === 'GET' && (pathname === '/health' || pathname === '/health/db')) {
      // The shape backend-reachability.ts classifies as `healthy`: a 200 whose
      // JSON body carries `status: "healthy"`.
      sendJson(response, 200, { status: 'healthy', database: { reachable: true }, screenshotBackend: true });
      return;
    }
    if (method === 'GET' && pathname === '/__screenshot-backend/status') {
      sendJson(response, 200, currentStats());
      return;
    }

    // Deliberately NOT proxied, in either mode. An unrecognised call is the one
    // thing a capture must learn about: proxying it would make the replay run
    // depend on PROD without anybody noticing.
    misses += 1;
    emit({ event: 'miss', kind: 'route', method, path: pathname });
    sendJson(response, 404, { error: `screenshot backend does not serve ${method} ${pathname}` });
  };

  const httpServer: Server = createServer((request, response) => {
    void route(request, response).catch((routeError: unknown) => {
      const detail = routeError instanceof Error ? routeError.message : String(routeError);
      if (!response.headersSent) sendJson(response, 500, { error: `screenshot backend failed: ${detail}` });
      else response.end();
    });
  });

  // -------------------------------------------------------------------------
  // graphql-ws (inert)
  // -------------------------------------------------------------------------

  // The only subscription the store screens open is ClimbStatsUpdated, and the
  // UI renders correctly when it never emits. So this speaks just enough of the
  // protocol to keep graphql-ws from retrying in a loop, and then stays silent.
  const webSocketServer = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => (protocols.has('graphql-transport-ws') ? 'graphql-transport-ws' : false),
  });

  // A malformed frame (bad RSV bits, an unmasked client frame, …) emits
  // `error` on the socket; without a listener Node treats that as unhandled
  // and crashes the whole process over one bad client.
  webSocketServer.on('error', (error: Error) => {
    emit({ event: 'ws-error', message: error.message });
  });

  webSocketServer.on('connection', (socket: WebSocket) => {
    socket.on('error', () => {
      // A malformed frame from one client must not take the server down —
      // `ws` already terminated this socket; nothing else to do here.
    });
    socket.on('message', (rawMessage) => {
      const message: unknown = ((): unknown => {
        try {
          return JSON.parse(rawFrameText(rawMessage));
        } catch {
          return null;
        }
      })();
      if (typeof message !== 'object' || message === null) return;
      const messageType = (message as { type?: unknown }).type;
      if (messageType === 'connection_init') {
        socket.send(JSON.stringify({ type: 'connection_ack' }));
        emit({ event: 'ws-ack' });
        return;
      }
      if (messageType === 'ping') {
        socket.send(JSON.stringify({ type: 'pong' }));
        return;
      }
      if (messageType === 'subscribe') {
        const payload = (message as { payload?: unknown }).payload;
        const operationName =
          typeof payload === 'object' && payload !== null
            ? (resolveOperationName(payload as { operationName?: unknown; query?: unknown }) ?? 'anonymous')
            : 'anonymous';
        emit({ event: 'ws-subscribe', operationName });
      }
      // `complete` and everything else: ignored on purpose.
    });
  });

  httpServer.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const upgradeUrl = new URL(request.url ?? '/', 'http://screenshot-backend.local');
    if (upgradeUrl.pathname !== '/graphql') {
      socket.destroy();
      return;
    }
    webSocketServer.handleUpgrade(request, socket, head, (socketConnection) => {
      webSocketServer.emit('connection', socketConnection, request);
    });
  });

  /**
   * Every manifest entry checked against the bytes actually on disk, BEFORE
   * replay starts serving.
   *
   * A capture is a long, expensive, mostly-unattended run, and a fixture that
   * turns out to be truncated or missing halfway through it costs the whole
   * capture — while at request time all it can honestly do is answer a miss.
   * So the fixture set is proved readable up front: every graphql fixture is
   * parsed and checked against the key the manifest filed it under, and every
   * static file's size is compared with the recorded byte count.
   */
  const unusableFixtureProblems = (): string[] => {
    const problems: string[] = [];
    for (const entry of manifest.graphql) {
      const label = `${entry.file} (${entry.operationName})`;
      if (!isFixtureFileWithinDirectory(fixturesDir, entry.file)) {
        problems.push(`${label} resolves outside the fixtures directory`);
        continue;
      }
      let fixture: unknown;
      try {
        fixture = JSON.parse(readFileSync(join(fixturesDir, entry.file), 'utf8'));
      } catch (readError) {
        const detail = readError instanceof Error ? readError.message : String(readError);
        problems.push(`${label} could not be read as JSON: ${detail}`);
        continue;
      }
      if (typeof fixture !== 'object' || fixture === null || Array.isArray(fixture)) {
        problems.push(`${label} is not a JSON object`);
        continue;
      }
      const recorded = fixture as Partial<GraphqlFixtureFile>;
      if (recorded.formatVersion !== SCREENSHOT_FIXTURE_FORMAT_VERSION) {
        problems.push(`${label} has formatVersion ${JSON.stringify(recorded.formatVersion)}`);
        continue;
      }
      // A fixture that disagrees with the entry pointing at it would replay
      // one operation's body under another operation's key.
      for (const field of ['operationName', 'documentHash', 'variablesHash'] as const) {
        if (recorded[field] !== entry[field]) {
          problems.push(
            `${label} has ${field} ${JSON.stringify(recorded[field])}, but the manifest says ${entry[field]}`,
          );
        }
      }
      if (!Object.hasOwn(recorded, 'response')) problems.push(`${label} has no recorded response`);
    }
    for (const entry of manifest.static) {
      const label = `${entry.file} (${entry.path})`;
      if (!isFixtureFileWithinDirectory(fixturesDir, entry.file)) {
        problems.push(`${label} resolves outside the fixtures directory`);
        continue;
      }
      let byteLength: number;
      try {
        byteLength = statSync(join(fixturesDir, entry.file)).size;
      } catch (statError) {
        const detail = statError instanceof Error ? statError.message : String(statError);
        problems.push(`${label} could not be read: ${detail}`);
        continue;
      }
      if (byteLength !== entry.bytes) {
        problems.push(`${label} is ${byteLength} bytes, but the manifest recorded ${entry.bytes}`);
      }
    }
    return problems;
  };

  return {
    listen(port: number): Promise<number> {
      return new Promise<number>((resolve, reject) => {
        if (!isRecording) {
          const fixtureProblems = unusableFixtureProblems();
          if (fixtureProblems.length > 0) {
            reject(
              new Error(
                [
                  `${fixtureProblems.length} recorded fixture(s) under ${fixturesDir} cannot be replayed:`,
                  ...fixtureProblems.map((problem) => `  - ${problem}`),
                  `record one again with \`${RE_RECORD_COMMAND}\`.`,
                ].join('\n'),
              ),
            );
            return;
          }
        }
        const onListenError = (listenError: Error): void => reject(listenError);
        httpServer.once('error', onListenError);
        // 0.0.0.0 so the iOS simulator (localhost) and the Android emulator
        // (adb reverse) both reach it.
        httpServer.listen(port, '0.0.0.0', () => {
          httpServer.removeListener('error', onListenError);
          const address = httpServer.address();
          const boundPort = typeof address === 'object' && address !== null ? address.port : port;
          emit({
            event: 'ready',
            mode,
            port: boundPort,
            fixturesDir,
            frozenNow,
            graphqlCount: manifest.graphql.length,
            staticCount: manifest.static.length,
          });
          resolve(boundPort);
        });
      });
    },
    close(): Promise<void> {
      // The final rewrite is belt-and-braces: the manifest is already rewritten
      // after every new entry, so a SIGTERM mid-capture still leaves a manifest
      // that matches the files on disk.
      if (isRecording) rewriteManifest();
      for (const socket of webSocketServer.clients) socket.terminate();
      return new Promise<void>((resolve) => {
        webSocketServer.close(() => {
          httpServer.close(() => resolve());
          httpServer.closeAllConnections();
        });
      });
    },
    stats: currentStats,
  };
}

/** Every file the fixture set actually holds, relative to `fixturesDir`. Used by tests and tooling. */
export function listFixtureFiles(fixturesDir: string): string[] {
  const files: string[] = [];
  const walk = (relativeDir: string): void => {
    const absoluteDir = join(fixturesDir, relativeDir);
    if (!existsSync(absoluteDir)) return;
    for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(relativePath);
      else files.push(relativePath);
    }
  };
  walk('');
  return files.sort();
}
