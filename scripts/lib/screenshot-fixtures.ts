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
 * `prod`. `--fixtures` lands with the orchestrator integration in a follow-up
 * PR; until then this is the target shape, not yet a runnable command.
 */
export const RE_RECORD_COMMAND =
  'vp run mobile:screenshots -- --fixtures record --backend prod --platform ios --devices common --locales en-US --fresh';

export type ScreenshotBackendMode = 'replay' | 'record';

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

export type GraphqlMissReason = 'no-fixture' | 'document-changed' | 'anonymous-operation' | 'unreadable-fixture';

const GRAPHQL_MISS_REASONS: readonly GraphqlMissReason[] = [
  'no-fixture',
  'document-changed',
  'anonymous-operation',
  'unreadable-fixture',
];

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
  | { event: 'hit'; kind: 'graphql'; operationName: string; hash12: string }
  | { event: 'hit'; kind: 'static'; subject: string }
  | { event: 'hit'; kind: 'auth'; route: AuthRoute }
  | { event: 'miss'; kind: 'graphql'; operationName: string; hash12: string; reason: GraphqlMissReason }
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
            return `HIT graphql ${line.operationName} ${line.hash12}`;
          case 'static':
            return `HIT static ${line.subject}`;
          case 'auth':
            return `HIT auth ${line.route}`;
        }
        break;
      case 'miss':
        switch (line.kind) {
          case 'graphql':
            return `MISS graphql ${line.operationName} ${line.hash12} reason=${line.reason}`;
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
const HIT_GRAPHQL_PATTERN = /^HIT graphql (\S+) (\S+)$/;
const HIT_STATIC_PATTERN = /^HIT static (\S+)$/;
const HIT_AUTH_PATTERN = /^HIT auth (\S+)$/;
const MISS_GRAPHQL_PATTERN = /^MISS graphql (\S+) (\S+) reason=(\S+)$/;
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
  if (hitGraphql) return { event: 'hit', kind: 'graphql', operationName: hitGraphql[1], hash12: hitGraphql[2] };

  const hitStatic = HIT_STATIC_PATTERN.exec(body);
  if (hitStatic) return { event: 'hit', kind: 'static', subject: hitStatic[1] };

  const hitAuth = HIT_AUTH_PATTERN.exec(body);
  if (hitAuth && isAuthRoute(hitAuth[1])) return { event: 'hit', kind: 'auth', route: hitAuth[1] };

  const missGraphql = MISS_GRAPHQL_PATTERN.exec(body);
  if (missGraphql && isGraphqlMissReason(missGraphql[3])) {
    return {
      event: 'miss',
      kind: 'graphql',
      operationName: missGraphql[1],
      hash12: missGraphql[2],
      reason: missGraphql[3],
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

function describeProblem(line: ScreenshotBackendLogLine): ScreenshotBackendProblem | null {
  switch (line.event) {
    case 'miss':
      switch (line.kind) {
        case 'graphql':
          switch (line.reason) {
            case 'no-fixture':
              return {
                description: `no recorded response for ${line.operationName} (variables ${line.hash12})`,
                remedy: RE_RECORD_REMEDY,
              };
            case 'document-changed':
              return {
                description: `the query text for ${line.operationName} moved since it was recorded (variables ${line.hash12})`,
                remedy: RE_RECORD_REMEDY,
              };
            case 'anonymous-operation':
              return {
                description: `an unnamed GraphQL operation reached the backend (variables ${line.hash12})`,
                remedy: `name the operation, then ${RE_RECORD_REMEDY}`,
              };
            case 'unreadable-fixture':
              return {
                description: `the recorded response for ${line.operationName} could not be read (variables ${line.hash12})`,
                remedy: `the fixture file is missing or malformed; ${RE_RECORD_REMEDY}`,
              };
          }
          break;
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
  let hitCount = 0;

  for (const rawLine of logText.split('\n')) {
    const line = parseScreenshotBackendLogLine(rawLine);
    if (!line) continue;
    if (line.event === 'hit') {
      hitCount += 1;
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

  if (options.mode === 'replay' && hitCount === 0) {
    problems.push(
      'no HIT lines in the screenshot backend log — the app never reached the replay backend; check that EXPO_PUBLIC_BACKEND_URL reached the Metro bundle.',
    );
  }
  return problems;
}
