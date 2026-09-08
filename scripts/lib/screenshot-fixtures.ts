/**
 * The screenshot fixture contract: how a recorded backend response is keyed, how
 * the manifest is shaped and validated, and the log grammar the replay/record
 * server speaks.
 *
 * PURE ON PURPOSE — no `node:` imports, no filesystem, no network. The server
 * (scripts/lib/screenshot-backend.ts) injects `sha256Hex` and does all the I/O,
 * and a mobile-side drift test can import this module under the React Native
 * vitest project without dragging Node builtins into that graph.
 */

/** Prefix every line the screenshot backend logs, so a tee'd capture log is greppable. */
export const SCREENSHOT_BACKEND_LOG_PREFIX = '[screenshot-backend]';

/** How much of a sha256 hex digest appears in a log line or a fixture filename. */
export const FIXTURE_HASH_DISPLAY_LENGTH = 12;

/** How much of a sha256 hex digest names a recorded static asset on disk. */
export const STATIC_KEY_LENGTH = 16;

/**
 * The exact command that rebuilds the fixture set from PROD. Quoted in every
 * remedy. `--fixtures record|replay` picks the fixture mode; `--backend
 * local|prod` picks the upstream the app talks to — a recording always targets
 * `prod`.
 */
export const RE_RECORD_COMMAND =
  'vp run mobile:screenshots -- --fixtures record --backend prod --platform ios --devices common --locales en-US --fresh';

export type ScreenshotBackendMode = 'replay' | 'record';

/**
 * Port the screenshot backend binds, and the port the orchestrator bakes into
 * the JS bundle's backend URLs. Defined here rather than in either caller so the
 * CLI default and the bundled URL cannot drift: a mismatch leaves the app
 * talking to nothing while the backend logs a clean, empty run.
 */
export const SCREENSHOT_BACKEND_DEFAULT_PORT = 8090;

/** Where a recorded fixture set lives, relative to the repo root. */
export const DEFAULT_SCREENSHOT_FIXTURES_DIR = 'packages/mobile/screenshot-fixtures';

/**
 * The backend port for this run: `BOARDSESH_SCREENSHOT_BACKEND_PORT` when it is
 * a usable port number, else the default. An unparseable or out-of-range
 * override falls back instead of throwing; the one caller that must reject a
 * bad value (the CLI's own `--port`) validates that flag itself.
 */
export function resolveScreenshotBackendPort(rawPort: string | undefined): number {
  const parsed = Number.parseInt(rawPort ?? '', 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) return SCREENSHOT_BACKEND_DEFAULT_PORT;
  return parsed;
}

/**
 * Now, to the second. Milliseconds are dropped so a recorded manifest reads
 * cleanly, and so the instant the orchestrator bakes into the JS bundle is the
 * exact string the manifest carries.
 */
export function startOfSecondIso(now: Date): string {
  return `${now.toISOString().slice(0, 19)}Z`;
}

/**
 * `startOfSecondIso`'s complement: the same epoch millisecond ceiled UP to the
 * start of its second, instead of truncated down. An instant already sitting
 * exactly on a whole second is returned unchanged.
 */
function ceilToSecondIso(epochMs: number): string {
  return startOfSecondIso(new Date(Math.ceil(epochMs / 1000) * 1000));
}

/**
 * The `frozenNow` a completed recording (or a merge of several) should use: a
 * capture is a long unattended run — one shard alone can take 20+ minutes — so
 * a `frozenNow` minted at the START and never revisited can end up EARLIER than
 * a response recorded near the end. Replaying that response would then render
 * its own wall-clock content (a tick's `firstTickAt`, a session's timestamp) as
 * being in the future relative to the frame the capture calls "now".
 *
 * The fix: `floorInstant` (the minted start instant, or an already-merged
 * `frozenNow`) is kept as-is UNLESS some response in `recordedAtInstants` was
 * recorded strictly after it — in which case the result moves to at least one
 * full second past the LATEST such response, ceiled to a whole second. A
 * response recorded before or at the floor needs no adjustment at all, so a
 * capture that didn't run long keeps the exact instant it minted.
 *
 * Applied at record time by `screenshot-backend.ts` (per fixture, against that
 * run's own start instant) and again at merge time by
 * `screenshot-fixtures-merge.ts` (per input, against that shard's own
 * `frozenNow`) — belt and braces, since a pre-fix or hand-edited input set
 * could still carry a `frozenNow` earlier than one of its own entries.
 */
export function finalizeRecordingFrozenNow(floorInstant: string, recordedAtInstants: readonly string[]): string {
  const floorMs = Date.parse(floorInstant);
  let latestResponseMs = -Infinity;
  for (const recordedAt of recordedAtInstants) {
    const parsedMs = Date.parse(recordedAt);
    if (parsedMs > latestResponseMs) latestResponseMs = parsedMs;
  }
  if (latestResponseMs <= floorMs) return floorInstant;
  // +1000ms before ceiling guarantees the result lands at least one full
  // second past latestResponseMs, however its own sub-second remainder falls —
  // ceiling alone (without the +1s) can land under a second away when
  // latestResponseMs already sits near the top of its second.
  return ceilToSecondIso(latestResponseMs + 1000);
}

// ---------------------------------------------------------------------------
// Keying
// ---------------------------------------------------------------------------

/**
 * The wire form of a GraphQL document, whitespace-insensitive.
 *
 * graphql-request's `gql` tag returns its template verbatim, so the bytes the
 * app POSTs are the bytes in the source file — including whatever indentation
 * the formatter last chose. Hashing the raw text would invalidate every fixture
 * the next time Prettier rewraps a query, so collapse runs of whitespace first.
 * That is deliberately NOT a GraphQL parse: pulling in `graphql` to normalise
 * punctuation would buy nothing this does not already cover, and would make the
 * recorder depend on the schema library the app happens to use.
 */
export function normalizeDocument(query: string): string {
  return query.replace(/\s+/g, ' ').trim();
}

function toCanonicalValue(value: unknown): unknown {
  if (value === null) return null;
  if (Array.isArray(value)) {
    // Array order is meaningful (it is an argument list), so only the elements
    // are canonicalised. A hole / explicit undefined becomes null, matching what
    // JSON.stringify would have done on the wire.
    return value.map((element) => (element === undefined ? null : toCanonicalValue(element)));
  }
  if (typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const entry = source[key];
      // Dropped, not nulled: `{ limit: undefined }` and `{}` are the same
      // request, and must land on the same fixture.
      if (entry === undefined) continue;
      sorted[key] = toCanonicalValue(entry);
    }
    return sorted;
  }
  return value;
}

/**
 * JSON with every object's keys in sorted order, `undefined` properties dropped,
 * arrays left in order and `null` preserved. Two requests that differ only in
 * key order must hash the same, or a JS engine's property-insertion order would
 * decide whether a capture hits its fixture.
 */
export function canonicalJson(value: unknown): string {
  const canonical = toCanonicalValue(value);
  if (canonical === undefined) return 'null';
  return JSON.stringify(canonical) ?? 'null';
}

/**
 * Variable paths excluded from a fixture's key, per operation.
 *
 * THE RULE: only client-generated per-run values belong here — uuids minted on
 * the device, push/device tokens, wall-clock stamps. Never a data-shaping input
 * (a filter, a page cursor, a board scope, a sort). Stripping one of those would
 * collapse two genuinely different responses onto one fixture and the capture
 * would silently shoot the wrong data.
 *
 * Applied IDENTICALLY at record and replay time, so a recorded key and a replay
 * lookup can never disagree about what was ignored.
 */
export const IGNORED_VARIABLE_PATHS: Readonly<Record<string, readonly string[]>> = {
  // One APNs push token, four operation names. The JS twins live in
  // packages/mobile/src/lib/graphql/operations.ts; the Live Activity module
  // sends the same two mutations under its own names from Swift
  // (packages/mobile/modules/live-activity/ios/LiveActivityModule.swift).
  RegisterActivityPushToken: ['token'],
  UnregisterActivityPushToken: ['token'],
  RegisterToken: ['token'],
  UnregisterToken: ['token'],
};

/**
 * What a persisted fixture holds in place of an ignored path's value.
 *
 * An ignored path is hashed out of the key AND redacted from the bytes. The key
 * already ignores the value, so writing the live one would commit a per-run
 * credential to the repo for nothing; the variable itself stays present, since
 * a fixture that dropped it would no longer show what the app sends.
 */
export const REDACTED_PER_RUN_VALUE = '<redacted:per-run>';

function cloneJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneJsonValue);
  if (typeof value === 'object' && value !== null) {
    const cloned: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) cloned[key] = cloneJsonValue(entry);
    return cloned;
  }
  return value;
}

function deleteDotPath(root: Record<string, unknown>, dotPath: string): void {
  const segments = dotPath.split('.');
  let cursor: Record<string, unknown> = root;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const next = cursor[segments[index]];
    // Tolerant by design: a path that does not exist in these variables is not
    // an error, it just means this call did not carry that field.
    if (typeof next !== 'object' || next === null || Array.isArray(next)) return;
    cursor = next as Record<string, unknown>;
  }
  delete cursor[segments[segments.length - 1]];
}

function redactDotPath(root: Record<string, unknown>, dotPath: string): void {
  const segments = dotPath.split('.');
  let cursor: Record<string, unknown> = root;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const next = cursor[segments[index]];
    // Tolerant, exactly like deleteDotPath: a path this call did not carry is
    // not an error, and must not be invented by the redaction.
    if (typeof next !== 'object' || next === null || Array.isArray(next)) return;
    cursor = next as Record<string, unknown>;
  }
  const leaf = segments[segments.length - 1];
  if (Object.hasOwn(cursor, leaf)) cursor[leaf] = REDACTED_PER_RUN_VALUE;
}

function ignoredPathsFor(operationName: string): readonly string[] {
  return Object.hasOwn(IGNORED_VARIABLE_PATHS, operationName) ? IGNORED_VARIABLE_PATHS[operationName] : [];
}

/** `variables` with this operation's ignored dot paths removed. Never mutates the input. */
export function stripIgnoredVariablePaths(operationName: string, variables: unknown): unknown {
  const ignoredPaths = ignoredPathsFor(operationName);
  if (ignoredPaths.length === 0) return variables;
  if (typeof variables !== 'object' || variables === null || Array.isArray(variables)) return variables;
  const stripped = cloneJsonValue(variables) as Record<string, unknown>;
  for (const dotPath of ignoredPaths) deleteDotPath(stripped, dotPath);
  return stripped;
}

/**
 * `variables` as they should be PERSISTED: every ignored path that this call
 * actually carried replaced by `REDACTED_PER_RUN_VALUE`. Never mutates the
 * input.
 *
 * The two-step rule, both halves applied at record time:
 *   1. `stripIgnoredVariablePaths` removes the path from the fixture KEY, so a
 *      later run with a different token still hits the same fixture.
 *   2. this replaces the value in the BYTES, so the recorded token is never
 *      committed.
 * Only the first is applied on replay — the key has to be computed the same way
 * on both sides, and replay writes nothing.
 */
export function redactIgnoredVariablePaths(operationName: string, variables: unknown): unknown {
  const ignoredPaths = ignoredPathsFor(operationName);
  if (ignoredPaths.length === 0) return variables;
  if (typeof variables !== 'object' || variables === null || Array.isArray(variables)) return variables;
  const redacted = cloneJsonValue(variables) as Record<string, unknown>;
  for (const dotPath of ignoredPaths) redactDotPath(redacted, dotPath);
  return redacted;
}

/**
 * A variable key that is itself a login secret's name, not merely a name that
 * mentions one. Anchored so it matches `password`, `secret`, `token`,
 * `credential` (and their plurals) exactly, or a `snake_case`-prefixed form
 * like `auth_token` — never a bare substring, so a legitimate counter like
 * `tokenCount` or a metadata field like `credentialsExpiry` does not sink an
 * otherwise-clean fixture.
 */
const SENSITIVE_VARIABLE_KEY_PATTERN = /(^|_)(password|secret|token|credential)s?$/i;

/**
 * Every variable key, at any depth (through nested objects and arrays), that
 * looks like it carries a login secret. `recordGraphql` calls this on every
 * response before writing a fixture: GraphQL is how this app forwards a
 * climber's Aurora board credentials (board login mutations take a
 * `password`), so — unlike header-derived tokens, which are caught by
 * `carriesSensitiveToken` — a secret can arrive as an ordinary request
 * variable and would otherwise be committed to the repo verbatim.
 *
 * A key already holding `REDACTED_PER_RUN_VALUE` is not reported: it carries no
 * secret any more, and refusing it would mean the Live Activity's push-token
 * mutations could never be recorded at all. Run this AFTER
 * `redactIgnoredVariablePaths`, so an ignored path is the only exemption and
 * every other `password`/`secret`/`token`/`credential` still refuses the
 * fixture.
 */
export function findSensitiveVariableKeys(variables: unknown): string[] {
  const sensitiveKeys = new Set<string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const element of value) walk(element);
      return;
    }
    if (typeof value !== 'object' || value === null) return;
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_VARIABLE_KEY_PATTERN.test(key) && entry !== REDACTED_PER_RUN_VALUE) sensitiveKeys.add(key);
      walk(entry);
    }
  };
  walk(variables);
  return [...sensitiveKeys].sort();
}

export type GraphqlFixtureKey = {
  operationName: string;
  /** sha256 of the whitespace-normalised document. */
  documentHash: string;
  /** sha256 of the canonical JSON of the variables, ignored paths removed. */
  variablesHash: string;
};

/**
 * The two hashes that identify one recorded GraphQL response. Split on purpose:
 * the variables hash picks the fixture (and names its file), the document hash
 * then says whether the query the app is sending is still the query that was
 * recorded — the difference between "nobody recorded this" and "this drifted".
 */
export function graphqlFixtureKey(
  request: { operationName: string; query: string; variables?: unknown },
  sha256Hex: (text: string) => string,
): GraphqlFixtureKey {
  const strippedVariables = stripIgnoredVariablePaths(request.operationName, request.variables ?? {});
  return {
    operationName: request.operationName,
    documentHash: sha256Hex(normalizeDocument(request.query)),
    variablesHash: sha256Hex(canonicalJson(strippedVariables)),
  };
}

/**
 * A GraphQL name, by spec, starts with a letter or underscore and continues
 * with letters, digits and underscores — nothing else. So this is not a taste
 * choice: an `operationName` outside that shape did not come from a real
 * GraphQL client and is never a value this module may use to build a
 * filesystem path (`graphqlFixturePath` keys a fixture's directory on it).
 */
const OPERATION_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The operation this POST body is for: the explicit `operationName` field when
 * graphql-request sent one and it looks like a real GraphQL name, else the
 * name declared in the document itself. `null` means an anonymous operation,
 * which the app should never send.
 */
export function resolveOperationName(body: { operationName?: unknown; query?: unknown }): string | null {
  if (typeof body.operationName === 'string' && OPERATION_NAME_PATTERN.test(body.operationName)) {
    return body.operationName;
  }
  if (typeof body.query !== 'string') return null;
  const declared = body.query.match(/\b(query|mutation|subscription)\s+([A-Za-z_]\w*)/);
  return declared ? declared[2] : null;
}

/** Query parameters in a stable order, so `?size=64&v=3` and `?v=3&size=64` are one key. */
export function sortedQueryString(searchParams: Iterable<[string, string]>): string {
  return [...searchParams]
    .sort((left, right) => (left[0] === right[0] ? left[1].localeCompare(right[1]) : left[0].localeCompare(right[0])))
    .map(([name, paramValue]) => `${encodeURIComponent(name)}=${encodeURIComponent(paramValue)}`)
    .join('&');
}

/**
 * The on-disk name of a recorded static asset: 16 hex characters over the
 * ORIGINAL path and its sorted query. PROD answers `/static/*` with a 302 to a
 * CDN, so the recorder follows the redirect but must key by what the app asked
 * for, never by where it landed.
 */
export function staticFixtureKey(
  pathname: string,
  searchParams: Iterable<[string, string]>,
  sha256Hex: (text: string) => string,
): string {
  return sha256Hex(`${pathname}?${sortedQueryString(searchParams)}`).slice(0, STATIC_KEY_LENGTH);
}

// ---------------------------------------------------------------------------
// Batched operations
// ---------------------------------------------------------------------------

/**
 * How one batched operation's request ids line up with its recorded response
 * items, so replay can answer an id subset nobody recorded verbatim.
 *
 * Both paths are dot paths: `idsVariablePath` into the request `variables`,
 * `responseListPath` into the WHOLE recorded response body (the `data`
 * envelope included, since that is what a fixture stores).
 */
export type BatchedOperationSpec = {
  /** Dot path inside `variables` of the id list this batch asks for. */
  idsVariablePath: string;
  /** Dot path inside the recorded response body of the list of items. */
  responseListPath: string;
  /** Field on each response item carrying the id it answers for. */
  responseIdField: string;
};

/**
 * Operations whose variables carry a LIST OF IDS assembled at runtime, so an
 * exact-variables key can never be stable for them.
 *
 * Both entries are viewport batches: `useQueries` over chunks of whatever rows
 * had mounted when the batch flushed
 * (`packages/mobile/src/lib/graphql/hooks/use-social.ts` for the vote
 * summaries, `fetchClimbStatsForClimbs` in
 * `packages/mobile/src/providers/board-adapter.tsx` for the stats). Replay is
 * instant, so the app scrolls and flushes on a different schedule than the
 * recording did and asks for id subsets the recording never sent as one batch.
 *
 * The fix is to key these by MEMBERSHIP: every recorded batch of the operation
 * is decomposed into id -> its recorded items, and a request is answered by
 * re-assembling the items for the ids it asked for. Everything OUTSIDE the id
 * list (a `boardName`, an `entityType`) still has to match exactly — those
 * shape the response, and composing across them would answer a Tension request
 * with Kilter rows.
 *
 * Adding one: read the operation document for the id list's path and the
 * response list's own id field, then confirm both against a committed fixture
 * (the drift test in
 * `packages/mobile/src/lib/graphql/__tests__/screenshot-fixture-drift.test.ts`
 * checks exactly that). Only add an operation whose response list is a per-id
 * lookup — never one whose items depend on the batch as a whole (a ranking, a
 * page, an aggregate over the set).
 */
export const BATCHED_OPERATIONS: Readonly<Record<string, BatchedOperationSpec>> = {
  // query ClimbStatsForClimbs($boardName: String!, $climbUuids: [ID!]!)
  // — packages/shared/graphql/src/operations/climb-stats-for-angles.ts.
  // One climb yields one row PER ANGLE, so an id maps to many items.
  ClimbStatsForClimbs: {
    idsVariablePath: 'climbUuids',
    responseListPath: 'data.climbStatsForClimbs',
    responseIdField: 'climbUuid',
  },
  // query GetBulkVoteSummaries($input: BulkVoteSummaryInput!)
  // — packages/shared/graphql/src/operations/comments-votes.ts.
  GetBulkVoteSummaries: {
    idsVariablePath: 'input.entityIds',
    responseListPath: 'data.bulkVoteSummaries',
    responseIdField: 'entityId',
  },
};

/** This operation's batch spec, or `null` when it is not a batched operation. */
export function batchedOperationSpec(operationName: string): BatchedOperationSpec | null {
  return Object.hasOwn(BATCHED_OPERATIONS, operationName) ? BATCHED_OPERATIONS[operationName] : null;
}

/** The value at `dotPath`, or `undefined` when any segment is missing or not an object. */
function readDotPath(root: unknown, dotPath: string): unknown {
  let cursor: unknown = root;
  for (const segment of dotPath.split('.')) {
    if (typeof cursor !== 'object' || cursor === null || Array.isArray(cursor)) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

/** Writes `value` at `dotPath`. False when a parent segment is missing, so the caller can bail. */
function setDotPath(root: Record<string, unknown>, dotPath: string, value: unknown): boolean {
  const segments = dotPath.split('.');
  let cursor: Record<string, unknown> = root;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const next = cursor[segments[index]];
    if (typeof next !== 'object' || next === null || Array.isArray(next)) return false;
    cursor = next as Record<string, unknown>;
  }
  cursor[segments[segments.length - 1]] = value;
  return true;
}

/**
 * The ids this request asks for, in request order. `null` when the variables do
 * not carry a list of strings there — a document that moved, or a call shaped
 * differently than the spec says — which leaves the request on the ordinary
 * exact-key path.
 */
export function batchRequestIds(spec: BatchedOperationSpec, variables: unknown): string[] | null {
  const ids = readDotPath(variables, spec.idsVariablePath);
  if (!Array.isArray(ids)) return null;
  if (!ids.every((id): id is string => typeof id === 'string')) return null;
  return ids;
}

/**
 * Everything about a batch request EXCEPT its ids, canonically. Two batches may
 * only be composed together when this matches: the id list is the part that
 * drifts with timing, the rest (`boardName`, `entityType`, a filter) shapes the
 * response.
 */
export function batchScopeKey(operationName: string, spec: BatchedOperationSpec, variables: unknown): string {
  const stripped = stripIgnoredVariablePaths(operationName, variables ?? {});
  if (typeof stripped !== 'object' || stripped === null || Array.isArray(stripped)) return canonicalJson(stripped);
  const withoutIds = cloneJsonValue(stripped) as Record<string, unknown>;
  deleteDotPath(withoutIds, spec.idsVariablePath);
  return canonicalJson(withoutIds);
}

/**
 * One recorded batch decomposed into id -> the items recorded for it. `null`
 * when the response has no list at `responseListPath`.
 *
 * EVERY id the recording asked for is seeded, including the ones the backend
 * had nothing to say about: "this climb has no stats" is a recorded fact, not a
 * gap, and treating it as unrecorded would make that climb miss forever no
 * matter how often the set is re-recorded.
 */
export function indexBatchItemsById(
  spec: BatchedOperationSpec,
  recordedIds: readonly string[],
  response: unknown,
): Map<string, unknown[]> | null {
  const items = readDotPath(response, spec.responseListPath);
  if (!Array.isArray(items)) return null;
  const itemsById = new Map<string, unknown[]>();
  for (const id of recordedIds) itemsById.set(id, []);
  for (const item of items) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
    const id = (item as Record<string, unknown>)[spec.responseIdField];
    if (typeof id !== 'string') continue;
    const bucket = itemsById.get(id);
    if (bucket) bucket.push(item);
    else itemsById.set(id, [item]);
  }
  return itemsById;
}

/**
 * A recorded response's envelope with `items` in place of its item list, so a
 * composed answer is shaped exactly like a recorded one. `ok: false` when the
 * template does not carry that path — nothing composable, answer a miss.
 */
export function composeBatchedResponse(
  spec: BatchedOperationSpec,
  templateResponse: unknown,
  items: readonly unknown[],
): { ok: true; response: unknown } | { ok: false } {
  if (typeof templateResponse !== 'object' || templateResponse === null || Array.isArray(templateResponse)) {
    return { ok: false };
  }
  const composed = cloneJsonValue(templateResponse) as Record<string, unknown>;
  if (!setDotPath(composed, spec.responseListPath, [...items])) return { ok: false };
  return { ok: true, response: composed };
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

export const SCREENSHOT_FIXTURE_FORMAT_VERSION = 1 as const;

export type GraphqlManifestEntry = {
  operationName: string;
  documentHash: string;
  variablesHash: string;
  /** Path relative to the fixtures dir, e.g. `graphql/SyncTicks/3f2a1b9c0d11.json`. */
  file: string;
};

export type StaticManifestEntry = {
  /** The pathname the app asked for, e.g. `/static/avatars/abc.jpg`. */
  path: string;
  /** The sorted query string, without the leading `?`. Empty when there was none. */
  query: string;
  /** Path relative to the fixtures dir, e.g. `static/6f1c….jpg`. */
  file: string;
  contentType: string;
  bytes: number;
};

export type ScreenshotFixtureManifest = {
  formatVersion: 1;
  recordedAt: string;
  /** The instant the capture pretends it is, so relative dates in the UI freeze. */
  frozenNow: string;
  /** The backend these fixtures came from. */
  upstream: string;
  /** The account the recording signed in as; replay only accepts this email. */
  accountEmail: string;
  /**
   * The `sub` claim of the jwt that account was issued — the user id the app
   * reads back out of its own token (`packages/mobile/src/lib/jwt-user-id.ts`).
   * Replay mints a synthetic jwt carrying this id, so screens that classify
   * data as "yours" behave as they did when the fixtures were recorded. The
   * live token is decoded in memory and NEVER written; only this id is.
   */
  accountUserId: string;
  /** Which capture flow was recorded (`app-store`, `onboarding`, …). */
  flow: string;
  graphql: GraphqlManifestEntry[];
  static: StaticManifestEntry[];
};

export function emptyManifest(fields: {
  recordedAt: string;
  frozenNow: string;
  upstream: string;
  accountEmail: string;
  accountUserId: string;
  flow: string;
}): ScreenshotFixtureManifest {
  return {
    formatVersion: SCREENSHOT_FIXTURE_FORMAT_VERSION,
    recordedAt: fields.recordedAt,
    frozenNow: fields.frozenNow,
    upstream: fields.upstream,
    accountEmail: fields.accountEmail,
    accountUserId: fields.accountUserId,
    flow: fields.flow,
    graphql: [],
    static: [],
  };
}

/**
 * Both entry lists in a stable order, so re-recording an unchanged capture
 * produces a byte-identical manifest and the diff shows only what moved.
 */
export function sortManifestEntries(manifest: ScreenshotFixtureManifest): ScreenshotFixtureManifest {
  return {
    ...manifest,
    graphql: [...manifest.graphql].sort((left, right) =>
      left.operationName === right.operationName
        ? left.variablesHash.localeCompare(right.variablesHash)
        : left.operationName.localeCompare(right.operationName),
    ),
    static: [...manifest.static].sort((left, right) =>
      left.path === right.path ? left.query.localeCompare(right.query) : left.path.localeCompare(right.path),
    ),
  };
}

export type GraphqlFixtureFile = {
  formatVersion: 1;
  operationName: string;
  documentHash: string;
  variablesHash: string;
  /** The document as recorded, kept so a drift can be diffed by eye. */
  query: string;
  variables: unknown;
  /** The upstream's whole JSON body, `errors` and all. */
  response: unknown;
  status: number;
  recordedAt: string;
  upstream: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * A manifest `file` is joined onto `fixturesDir` and read straight off disk, so
 * it must be a plain relative path that cannot leave the tree it was recorded
 * into: no absolute path, no backslash (a Windows separator `path.join` would
 * not normalise away on POSIX), no `..` segment, and it must actually sit
 * under the subtree it claims to (`graphql/` or `static/`). Returns the rule
 * that failed, or `null` when the path is safe.
 */
function unsafeFixtureFileRule(file: string, requiredPrefix: 'graphql/' | 'static/'): string | null {
  if (file.startsWith('/')) return 'must not be an absolute path';
  if (file.includes('\\')) return 'must not contain a backslash';
  if (file.split('/').includes('..')) return 'must not contain a ".." segment';
  if (!file.startsWith(requiredPrefix)) return `must start with "${requiredPrefix}"`;
  return null;
}

function graphqlEntryProblem(entry: unknown, index: number): string | null {
  if (!isRecord(entry)) return `graphql[${index}] is not an object`;
  if (!isNonEmptyString(entry.operationName)) return `graphql[${index}].operationName must be a non-empty string`;
  if (!isNonEmptyString(entry.documentHash)) return `graphql[${index}].documentHash must be a non-empty string`;
  if (!isNonEmptyString(entry.variablesHash)) return `graphql[${index}].variablesHash must be a non-empty string`;
  if (!isNonEmptyString(entry.file)) return `graphql[${index}].file must be a non-empty string`;
  const fileRule = unsafeFixtureFileRule(entry.file, 'graphql/');
  if (fileRule) return `graphql[${index}].file ${fileRule}`;
  return null;
}

function staticEntryProblem(entry: unknown, index: number): string | null {
  if (!isRecord(entry)) return `static[${index}] is not an object`;
  if (!isNonEmptyString(entry.path)) return `static[${index}].path must be a non-empty string`;
  if (typeof entry.query !== 'string') return `static[${index}].query must be a string`;
  if (!isNonEmptyString(entry.file)) return `static[${index}].file must be a non-empty string`;
  const fileRule = unsafeFixtureFileRule(entry.file, 'static/');
  if (fileRule) return `static[${index}].file ${fileRule}`;
  if (!isNonEmptyString(entry.contentType)) return `static[${index}].contentType must be a non-empty string`;
  if (typeof entry.bytes !== 'number' || !Number.isInteger(entry.bytes) || entry.bytes < 0) {
    return `static[${index}].bytes must be a non-negative integer`;
  }
  return null;
}

export type ScreenshotFixtureManifestValidation =
  | { ok: true; manifest: ScreenshotFixtureManifest }
  | { ok: false; reason: string };

/**
 * Structurally validate a parsed manifest. Hand-rolled like the board-snapshot
 * validator next door, and for the same reason: a capture that silently replays
 * half a fixture set is worse than one that refuses to start, so every field is
 * checked and the reason names the field that failed.
 */
export function validateScreenshotFixtureManifest(value: unknown): ScreenshotFixtureManifestValidation {
  if (!isRecord(value)) return { ok: false, reason: 'manifest is not a JSON object' };
  if (value.formatVersion !== SCREENSHOT_FIXTURE_FORMAT_VERSION) {
    return {
      ok: false,
      reason: `formatVersion must be ${SCREENSHOT_FIXTURE_FORMAT_VERSION}, got ${JSON.stringify(value.formatVersion)}`,
    };
  }
  if (!isNonEmptyString(value.recordedAt)) return { ok: false, reason: 'recordedAt must be a non-empty string' };
  if (!isNonEmptyString(value.frozenNow)) return { ok: false, reason: 'frozenNow must be a non-empty string' };
  if (!isNonEmptyString(value.upstream)) return { ok: false, reason: 'upstream must be a non-empty string' };
  if (typeof value.accountEmail !== 'string') return { ok: false, reason: 'accountEmail must be a string' };
  if (typeof value.accountUserId !== 'string') return { ok: false, reason: 'accountUserId must be a string' };
  if (typeof value.flow !== 'string') return { ok: false, reason: 'flow must be a string' };
  if (!Array.isArray(value.graphql)) return { ok: false, reason: 'graphql must be an array' };
  if (!Array.isArray(value.static)) return { ok: false, reason: 'static must be an array' };
  for (const [index, entry] of value.graphql.entries()) {
    const problem = graphqlEntryProblem(entry, index);
    if (problem) return { ok: false, reason: problem };
  }
  for (const [index, entry] of value.static.entries()) {
    const problem = staticEntryProblem(entry, index);
    if (problem) return { ok: false, reason: problem };
  }
  return { ok: true, manifest: value as ScreenshotFixtureManifest };
}

// ---------------------------------------------------------------------------
// Log grammar
// ---------------------------------------------------------------------------

export type GraphqlMissReason =
  | 'no-fixture'
  | 'document-changed'
  | 'anonymous-operation'
  | 'unreadable-fixture'
  /** A batched operation (see `BATCHED_OPERATIONS`) asked for ids no recorded batch covers. */
  | 'unrecorded-ids';

const GRAPHQL_MISS_REASONS: readonly GraphqlMissReason[] = [
  'no-fixture',
  'document-changed',
  'anonymous-operation',
  'unreadable-fixture',
  'unrecorded-ids',
];

/**
 * How much of a miss's canonical variables JSON reaches the log line.
 *
 * The line used to carry only the 12-character variables hash, which meant
 * diagnosing a miss from a CI artifact came down to brute-forcing the hash
 * offline. The variables themselves are the answer to "what did the app
 * actually ask for", so they go in the line — truncated, because a batch of 28
 * uuids is not worth 1 kB of log per miss.
 */
export const MISS_VARIABLES_LOG_LIMIT = 600;

/** How many unrecorded ids a `reason=unrecorded-ids` miss names before it stops. */
export const MISS_UNRECORDED_IDS_LOG_LIMIT = 10;

/**
 * The variables of a miss, canonically and with the ignored paths stripped —
 * exactly what the fixture key was computed over, so the line explains its own
 * hash. Elided past `MISS_VARIABLES_LOG_LIMIT`.
 */
export function formatMissVariables(operationName: string, variables: unknown): string {
  const canonical = canonicalJson(stripIgnoredVariablePaths(operationName, variables ?? {}));
  return canonical.length <= MISS_VARIABLES_LOG_LIMIT ? canonical : `${canonical.slice(0, MISS_VARIABLES_LOG_LIMIT)}…`;
}

/** The ids a `reason=unrecorded-ids` line names, capped. */
export function cappedUnrecordedIds(ids: readonly string[]): string[] {
  return ids.slice(0, MISS_UNRECORDED_IDS_LOG_LIMIT);
}

/**
 * One line of the backend log, parsed. The server never writes a line by hand —
 * it builds one of these and calls `formatScreenshotBackendLine`, so the parser
 * below and the producer cannot drift.
 */
export type ScreenshotBackendLogLine =
  | {
      event: 'ready';
      mode: ScreenshotBackendMode;
      port: number;
      fixturesDir: string;
      frozenNow: string;
      graphqlCount: number;
      staticCount: number;
    }
  | {
      event: 'hit';
      kind: 'graphql';
      operationName: string;
      hash12: string;
      /**
       * How many requested ids a batched hit was composed from recorded
       * batches (see `BATCHED_OPERATIONS`). `null` for an ordinary
       * exact-key hit, which is every non-batched operation.
       */
      composed: number | null;
    }
  | { event: 'hit'; kind: 'static'; subject: string }
  | { event: 'hit'; kind: 'auth'; route: AuthRoute }
  | {
      event: 'miss';
      kind: 'graphql';
      operationName: string;
      hash12: string;
      reason: GraphqlMissReason;
      /**
       * Requested ids no recorded batch covers, capped at
       * `MISS_UNRECORDED_IDS_LOG_LIMIT`. Empty unless the reason is
       * `unrecorded-ids`. An id carrying whitespace would split the log field;
       * these are GraphQL id scalars (uuids), and the same ids also appear
       * inside `variables`, so the parser tolerates it rather than guarding it.
       */
      unrecordedIds: readonly string[];
      /** Canonical variables JSON, ignored paths stripped — see `formatMissVariables`. */
      variables: string;
    }
  | { event: 'miss'; kind: 'static'; subject: string }
  | { event: 'miss'; kind: 'route'; method: string; path: string }
  | { event: 'miss'; kind: 'auth'; email: string; expectedEmail: string }
  | { event: 'recorded'; kind: 'graphql'; operationName: string; hash12: string; file: string }
  | { event: 'recorded'; kind: 'static'; subject: string; file: string }
  | { event: 'duplicate'; operationName: string; hash12: string }
  /** `detail` is `status=<n>` or `code=INTERNAL_SERVER_ERROR`. */
  | { event: 'upstream-error'; operationName: string; detail: string }
  | { event: 'redacted'; operationName: string }
  /** `note` is the free-text tail, e.g. `seen with 21 distinct variable sets`. */
  | { event: 'note'; operationName: string; note: string }
  | { event: 'ws-ack' }
  | { event: 'ws-subscribe'; operationName: string }
  /** A frame the `ws` server rejected (bad RSV bits, an unmasked client frame, …). Never a problem line: one bad client did not take the server down. */
  | { event: 'ws-error'; message: string };

/** The two replay auth routes a hit can be logged against. */
export type AuthRoute = 'credentials' | 'refresh';

/** How many recorded variants of one operation is enough to be worth a second look. */
export const VARIANT_COUNT_NOTE_THRESHOLD = 20;

/** Fixtures past this size are worth a note — something is being recorded that no screenshot needs. */
export const FIXTURE_SIZE_NOTE_BYTES = 2 * 1024 * 1024;

export function variantCountNote(variantCount: number): string {
  return `seen with ${variantCount} distinct variable sets`;
}

export function fixtureSizeNote(bytes: number): string {
  return `fixture is ${bytes} bytes, over the ${FIXTURE_SIZE_NOTE_BYTES} byte budget`;
}

export function formatScreenshotBackendLine(line: ScreenshotBackendLogLine): string {
  const body = ((): string => {
    switch (line.event) {
      case 'ready':
        return `READY mode=${line.mode} port=${line.port} fixtures=${line.fixturesDir} frozenNow=${line.frozenNow} graphql=${line.graphqlCount} static=${line.staticCount}`;
      case 'hit':
        switch (line.kind) {
          case 'graphql':
            return line.composed === null
              ? `HIT graphql ${line.operationName} ${line.hash12}`
              : `HIT graphql ${line.operationName} ${line.hash12} composed=${line.composed}`;
          case 'static':
            return `HIT static ${line.subject}`;
          case 'auth':
            return `HIT auth ${line.route}`;
        }
        break;
      case 'miss':
        switch (line.kind) {
          case 'graphql': {
            const ids = line.unrecordedIds.length > 0 ? ` ids=${line.unrecordedIds.join(',')}` : '';
            return `MISS graphql ${line.operationName} ${line.hash12} reason=${line.reason}${ids} variables=${line.variables}`;
          }
          case 'static':
            return `MISS static ${line.subject}`;
          case 'route':
            return `MISS route ${line.method} ${line.path}`;
          case 'auth':
            return `MISS auth email=${line.email} expected=${line.expectedEmail}`;
        }
        break;
      case 'recorded':
        return line.kind === 'graphql'
          ? `RECORDED graphql ${line.operationName} ${line.hash12} -> ${line.file}`
          : `RECORDED static ${line.subject} -> ${line.file}`;
      case 'duplicate':
        return `DUP graphql ${line.operationName} ${line.hash12}`;
      case 'upstream-error':
        return `UPSTREAM-ERROR graphql ${line.operationName} ${line.detail}`;
      case 'redacted':
        return `REDACTED graphql ${line.operationName}`;
      case 'note':
        return `NOTE graphql ${line.operationName} ${line.note}`;
      case 'ws-ack':
        return 'WS connection_init ack';
      case 'ws-subscribe':
        return `WS subscribe ${line.operationName}`;
      case 'ws-error':
        return `WS error ${line.message}`;
    }
    // Unreachable while the union above is exhaustive; kept so a future variant
    // fails loudly here rather than logging `undefined`.
    throw new Error(`unhandled screenshot backend log line: ${JSON.stringify(line)}`);
  })();
  return `${SCREENSHOT_BACKEND_LOG_PREFIX} ${body}`;
}

const READY_PATTERN =
  /^READY mode=(replay|record) port=(\d+) fixtures=(.+) frozenNow=(\S+) graphql=(\d+) static=(\d+)$/;
const HIT_GRAPHQL_PATTERN = /^HIT graphql (\S+) (\S+)(?: composed=(\d+))?$/;
const HIT_STATIC_PATTERN = /^HIT static (\S+)$/;
const HIT_AUTH_PATTERN = /^HIT auth (\S+)$/;
// `ids=` is non-greedy and `variables=` takes the rest of the line: the ids are
// GraphQL id scalars and the variables are single-line JSON, but only one of
// the two can safely be last. Both tails stay optional so a log written by an
// older backend build (hash only) still parses — an unparsed MISS line would
// vanish from `findScreenshotBackendProblems` and pass a broken capture.
const MISS_GRAPHQL_PATTERN = /^MISS graphql (\S+) (\S+) reason=([a-z-]+)(?: ids=(.*?))?(?: variables=(.*))?$/;
const MISS_STATIC_PATTERN = /^MISS static (\S+)$/;
const MISS_ROUTE_PATTERN = /^MISS route (\S+) (\S+)$/;
const MISS_AUTH_PATTERN = /^MISS auth email=(\S*) expected=(\S*)$/;
const RECORDED_GRAPHQL_PATTERN = /^RECORDED graphql (\S+) (\S+) -> (\S+)$/;
const RECORDED_STATIC_PATTERN = /^RECORDED static (\S+) -> (\S+)$/;
const DUP_PATTERN = /^DUP graphql (\S+) (\S+)$/;
const UPSTREAM_ERROR_PATTERN = /^UPSTREAM-ERROR graphql (\S+) (\S+)$/;
const REDACTED_PATTERN = /^REDACTED graphql (\S+)$/;
const NOTE_PATTERN = /^NOTE graphql (\S+) (.+)$/;
const WS_SUBSCRIBE_PATTERN = /^WS subscribe (\S+)$/;
const WS_ERROR_PATTERN = /^WS error (.+)$/;

function isGraphqlMissReason(value: string): value is GraphqlMissReason {
  return (GRAPHQL_MISS_REASONS as readonly string[]).includes(value);
}

function isAuthRoute(value: string): value is AuthRoute {
  return value === 'credentials' || value === 'refresh';
}

/** Parse one log line, or `null` when it is not one of ours. */
export function parseScreenshotBackendLogLine(line: string): ScreenshotBackendLogLine | null {
  const prefixIndex = line.indexOf(SCREENSHOT_BACKEND_LOG_PREFIX);
  if (prefixIndex === -1) return null;
  // Sliced rather than anchored: the capture log is a tee of Metro/child output,
  // so our line often arrives behind a timestamp or a stream tag.
  const body = line.slice(prefixIndex + SCREENSHOT_BACKEND_LOG_PREFIX.length).trim();

  const ready = READY_PATTERN.exec(body);
  if (ready) {
    return {
      event: 'ready',
      mode: ready[1] === 'record' ? 'record' : 'replay',
      port: Number(ready[2]),
      fixturesDir: ready[3],
      frozenNow: ready[4],
      graphqlCount: Number(ready[5]),
      staticCount: Number(ready[6]),
    };
  }

  const hitGraphql = HIT_GRAPHQL_PATTERN.exec(body);
  if (hitGraphql) {
    return {
      event: 'hit',
      kind: 'graphql',
      operationName: hitGraphql[1],
      hash12: hitGraphql[2],
      composed: hitGraphql[3] === undefined ? null : Number(hitGraphql[3]),
    };
  }

  const hitStatic = HIT_STATIC_PATTERN.exec(body);
  if (hitStatic) return { event: 'hit', kind: 'static', subject: hitStatic[1] };

  const hitAuth = HIT_AUTH_PATTERN.exec(body);
  if (hitAuth && isAuthRoute(hitAuth[1])) return { event: 'hit', kind: 'auth', route: hitAuth[1] };

  const missGraphql = MISS_GRAPHQL_PATTERN.exec(body);
  if (missGraphql && isGraphqlMissReason(missGraphql[3])) {
    const ids = missGraphql[4];
    return {
      event: 'miss',
      kind: 'graphql',
      operationName: missGraphql[1],
      hash12: missGraphql[2],
      reason: missGraphql[3],
      unrecordedIds: ids === undefined || ids.length === 0 ? [] : ids.split(','),
      variables: missGraphql[5] ?? '',
    };
  }

  const missStatic = MISS_STATIC_PATTERN.exec(body);
  if (missStatic) return { event: 'miss', kind: 'static', subject: missStatic[1] };

  const missRoute = MISS_ROUTE_PATTERN.exec(body);
  if (missRoute) return { event: 'miss', kind: 'route', method: missRoute[1], path: missRoute[2] };

  const missAuth = MISS_AUTH_PATTERN.exec(body);
  if (missAuth) return { event: 'miss', kind: 'auth', email: missAuth[1], expectedEmail: missAuth[2] };

  const recordedGraphql = RECORDED_GRAPHQL_PATTERN.exec(body);
  if (recordedGraphql) {
    return {
      event: 'recorded',
      kind: 'graphql',
      operationName: recordedGraphql[1],
      hash12: recordedGraphql[2],
      file: recordedGraphql[3],
    };
  }

  const recordedStatic = RECORDED_STATIC_PATTERN.exec(body);
  if (recordedStatic) {
    return { event: 'recorded', kind: 'static', subject: recordedStatic[1], file: recordedStatic[2] };
  }

  const duplicate = DUP_PATTERN.exec(body);
  if (duplicate) return { event: 'duplicate', operationName: duplicate[1], hash12: duplicate[2] };

  const upstreamError = UPSTREAM_ERROR_PATTERN.exec(body);
  if (upstreamError) return { event: 'upstream-error', operationName: upstreamError[1], detail: upstreamError[2] };

  const redacted = REDACTED_PATTERN.exec(body);
  if (redacted) return { event: 'redacted', operationName: redacted[1] };

  const note = NOTE_PATTERN.exec(body);
  if (note) return { event: 'note', operationName: note[1], note: note[2] };

  if (body === 'WS connection_init ack') return { event: 'ws-ack' };

  const wsSubscribe = WS_SUBSCRIBE_PATTERN.exec(body);
  if (wsSubscribe) return { event: 'ws-subscribe', operationName: wsSubscribe[1] };

  const wsError = WS_ERROR_PATTERN.exec(body);
  if (wsError) return { event: 'ws-error', message: wsError[1] };

  return null;
}

// ---------------------------------------------------------------------------
// Problem reporting
// ---------------------------------------------------------------------------

const RE_RECORD_REMEDY = `re-record with \`${RE_RECORD_COMMAND}\`.`;
const UNKNOWN_ROUTE_REMEDY =
  'add a handler to scripts/lib/screenshot-backend.ts or stop the app calling it in screenshot mode.';

/** What went wrong, and what to do about it. Kept apart so the `×N` count can sit between them. */
type ScreenshotBackendProblem = { description: string; remedy: string };

/**
 * `variables <hash12>`, plus the variables themselves when the line carried
 * them. The hash alone used to be the whole story, which meant reading a CI
 * artifact and then brute-forcing the hash locally to learn what the app had
 * asked for. The variables are also what makes each problem its own map key, so
 * only the FIRST occurrence's are printed and repeats still collapse into `×N`.
 */
function describeMissVariables(hash12: string, variables: string): string {
  return variables.length > 0 ? `variables ${hash12} = ${variables}` : `variables ${hash12}`;
}

function describeProblem(line: ScreenshotBackendLogLine): ScreenshotBackendProblem | null {
  switch (line.event) {
    case 'miss':
      switch (line.kind) {
        case 'graphql': {
          const variables = describeMissVariables(line.hash12, line.variables);
          switch (line.reason) {
            case 'no-fixture':
              return {
                description: `no recorded response for ${line.operationName} (${variables})`,
                remedy: RE_RECORD_REMEDY,
              };
            case 'document-changed':
              return {
                description: `the query text for ${line.operationName} moved since it was recorded (${variables})`,
                remedy: RE_RECORD_REMEDY,
              };
            case 'anonymous-operation':
              return {
                description: `an unnamed GraphQL operation reached the backend (${variables})`,
                remedy: `name the operation, then ${RE_RECORD_REMEDY}`,
              };
            case 'unreadable-fixture':
              return {
                description: `the recorded response for ${line.operationName} could not be read (${variables})`,
                remedy: `the fixture file is missing or malformed; ${RE_RECORD_REMEDY}`,
              };
            case 'unrecorded-ids':
              return {
                description: `${line.operationName} asked for ids no recorded batch covers: ${line.unrecordedIds.join(', ')} (${variables})`,
                remedy: `these rows were never on screen when the set was recorded — capture the screen they appear on and ${RE_RECORD_REMEDY}`,
              };
          }
          break;
        }
        case 'static':
          return { description: `no recorded bytes for the asset ${line.subject}`, remedy: RE_RECORD_REMEDY };
        case 'route':
          return {
            description: `the app called ${line.method} ${line.path}, which the screenshot backend does not serve`,
            remedy: UNKNOWN_ROUTE_REMEDY,
          };
        case 'auth':
          return {
            description: `the app signed in as ${line.email} but the fixtures were recorded for ${line.expectedEmail}`,
            remedy: `point the capture at the recorded account, or ${RE_RECORD_REMEDY}`,
          };
      }
      break;
    case 'upstream-error':
      return {
        description: `upstream refused ${line.operationName} (${line.detail}) so nothing was recorded for it`,
        remedy: `fix the backend or the recording account, then ${RE_RECORD_REMEDY}`,
      };
    default:
      return null;
  }
  return null;
}

/** The log lines that count as a problem in this mode. */
function isProblemLine(line: ScreenshotBackendLogLine, mode: ScreenshotBackendMode): boolean {
  if (mode === 'replay') return line.event === 'miss';
  // Recording is ALLOWED to miss — that is what recording is. Only the two
  // things a recording run cannot fix by itself count against it.
  return line.event === 'upstream-error' || (line.event === 'miss' && (line.kind === 'route' || line.kind === 'auth'));
}

/**
 * Everything wrong with a capture, read off the backend log.
 *
 * Both modes fail SILENTLY in the PNGs otherwise: a replay miss renders an empty
 * list that looks like a legitimately empty account, and a record-mode upstream
 * error leaves a fixture set whose gap only shows up on the NEXT capture.
 *
 * One line per distinct problem, repeats collapsed into a `×N` count, every line
 * ending in what to do about it.
 */
export function findScreenshotBackendProblems(logText: string, options: { mode: ScreenshotBackendMode }): string[] {
  const problemCounts = new Map<string, { problem: ScreenshotBackendProblem; count: number }>();
  // Only a GraphQL hit counts as "the app actually exercised a screen's data" —
  // an app that only ever authenticated (HIT auth) never reached a screen at
  // all, and must still fail the check below rather than being credited for it.
  let graphqlHitCount = 0;

  for (const rawLine of logText.split('\n')) {
    const line = parseScreenshotBackendLogLine(rawLine);
    if (!line) continue;
    if (line.event === 'hit') {
      if (line.kind === 'graphql') graphqlHitCount += 1;
      continue;
    }
    if (!isProblemLine(line, options.mode)) continue;
    const problem = describeProblem(line);
    if (!problem) continue;
    const existing = problemCounts.get(problem.description);
    if (existing) existing.count += 1;
    else problemCounts.set(problem.description, { problem, count: 1 });
  }

  const problems = [...problemCounts.values()].map(
    ({ problem, count }) => `${problem.description}${count > 1 ? ` ×${count}` : ''} — ${problem.remedy}`,
  );

  if (options.mode === 'replay' && graphqlHitCount === 0) {
    problems.push(
      'no HIT graphql lines in the screenshot backend log — the app never reached the replay backend; check that EXPO_PUBLIC_BACKEND_URL reached the Metro bundle.',
    );
  }
  return problems;
}
