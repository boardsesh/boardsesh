/**
 * Read-only evidence collection for issue #3909.
 *
 * This command has no apply mode and emits no SQL. It classifies only
 * reciprocal one-to-one candidate/anchor pairs from one serializable,
 * read-only, deferrable PostgreSQL snapshot. The JSONL artifact is evidence for
 * a separately reviewed correction design; it is not an executable backfill.
 */
import { constants as fsConstants } from 'node:fs';
import { access, link, lstat, open, realpath, unlink } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import postgres from 'postgres';
import {
  AUDIT_POLICY_VERSION,
  SMALL_CELL_THRESHOLD,
  analyzeTickGroup,
  anchorTimestampEvidence,
  assertPrivacySafeRecord,
  candidateTimestampEvidence,
  canonicalJson,
  epochSecondsToIso,
  groupKey,
  originEvidence,
  pseudonymize,
  redactSmallCell,
  sha256Hex,
  type AuditPolicy,
  type AuditTick,
  type CandidateGraphResult,
  type TickOrigin,
  type TickStatus,
} from './legacy-timestamp-audit-core.js';

export const JSON_BUG_INTRO_SOURCE_REVISION = '8fe79f60dd017180d325ba3501a8a2a96f7fcb28';
export const JSON_NAIVE_UTC_FIX_SOURCE_REVISION = '79185b916800b866173da01e4ec34743b0015218';
export const JSON_IMPORT_MOVE_SOURCE_REVISION = '45cef340a8055d5c263fac3d863dcf82886fb47b';
export const LIVE_PULL_SHARED_NORMALIZER_FIX_SOURCE_REVISION = '71937db6a372ececfe4fa543978ea5cd3bd78a88';
export const EXPLICIT_OFFSET_SUFFIX_FIX_SOURCE_REVISION = 'ad4b39c086b3e2b091bf1d16e5e529fe012d2cf1';
export const LEGACY_WEB_SAVE_ASCENT_NORMALIZER_FIX_SOURCE_REVISION = 'cdf1406dfb53f1865513fd005d39b13f469a74e1';
export const AUDIT_FORMAT_VERSION = 1;
export const AUDIT_CURSOR_ROWS = 500;
export const MAX_ROWS_PER_NATURAL_KEY = 10_000;

// Explicit epoch conversion avoids session-dependent parsing of timestamp
// without time zone. The ORDER BY follows boardsesh_ticks_user_climb_lookup_idx
// through (user_id, board_type, angle, climb_uuid); id makes the stream stable.
// Native deliberately has no created_at cutoff: even an ineligible historical
// row must contribute graph degree and can force an ambiguity abstention.
export const AUDIT_SCAN_QUERY = `
SELECT
  id::text AS "id",
  uuid AS "uuid",
  user_id AS "userId",
  board_type AS "boardType",
  climb_uuid AS "climbUuid",
  angle AS "angle",
  COALESCE(is_mirror, false) AS "isMirror",
  origin::text AS "origin",
  status::text AS "status",
  attempt_count AS "attemptCount",
  EXTRACT(EPOCH FROM climbed_at AT TIME ZONE 'UTC')::double precision AS "climbedAtEpochSeconds",
  EXTRACT(EPOCH FROM created_at AT TIME ZONE 'UTC')::double precision AS "createdAtEpochSeconds",
  EXTRACT(EPOCH FROM updated_at AT TIME ZONE 'UTC')::double precision AS "updatedAtEpochSeconds",
  (created_at = updated_at) AS "createdAtEqualsUpdatedAt",
  CASE WHEN aurora_synced_at IS NULL THEN NULL
       ELSE EXTRACT(EPOCH FROM aurora_synced_at AT TIME ZONE 'UTC')::double precision END
    AS "auroraSyncedAtEpochSeconds",
  COALESCE(aurora_id LIKE 'json-import-%', false) AS "auroraIdIsSyntheticJson",
  CASE WHEN kilter_synced_at IS NULL THEN NULL
       ELSE EXTRACT(EPOCH FROM kilter_synced_at AT TIME ZONE 'UTC')::double precision END
    AS "kilterSyncedAtEpochSeconds",
  CASE WHEN kilter_detached_at IS NULL THEN NULL
       ELSE EXTRACT(EPOCH FROM kilter_detached_at AT TIME ZONE 'UTC')::double precision END
    AS "kilterDetachedAtEpochSeconds"
FROM boardsesh_ticks
WHERE origin IN ('json_import', 'aurora_pull', 'kilter_pull', 'native')
ORDER BY user_id, board_type, angle, climb_uuid, id
`;

export const AUDIT_QUERY_SHA256 = sha256Hex(AUDIT_SCAN_QUERY);

type CliArgs = {
  outputPath: string;
  policy: AuditPolicy;
};

export class CliUsageError extends Error {}

const OPTION_NAMES = [
  '--output',
  '--policy-id',
  '--live-old-code-active-through',
  '--live-fixed-code-active-from',
  '--json-old-code-active-through',
  '--json-fixed-code-active-from',
  '--origin-writers-active-from',
  '--native-safe-generation-active-from',
] as const;

const GIT_ENVIRONMENT_PASSTHROUGH = ['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'TMPDIR', 'TMP', 'TEMP'] as const;

/**
 * Git's repository, index, config, and pathspec behavior is extensively
 * environment-configurable. Audit output protection must describe the output
 * parent on disk, not a caller-selected alternate Git view, so pass only the
 * process values needed to locate and run Git plus fixed defensive settings.
 */
function gitProbeEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of GIT_ENVIRONMENT_PASSTHROUGH) {
    const inheritedValue = process.env[name];
    if (inheritedValue !== undefined) environment[name] = inheritedValue;
  }
  return {
    ...environment,
    GIT_ATTR_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_DISCOVERY_ACROSS_FILESYSTEM: '1',
    GIT_LITERAL_PATHSPECS: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    LANG: 'C',
    LC_ALL: 'C',
  };
}

function parseInstant(option: string, rawValue: string): number {
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(rawValue)) {
    throw new CliUsageError(`${option} must include an explicit Z or numeric UTC offset`);
  }
  const epochMilliseconds = Date.parse(rawValue);
  if (!Number.isFinite(epochMilliseconds)) throw new CliUsageError(`${option} is not a valid timestamp`);
  return epochMilliseconds / 1000;
}

function requireOption(options: Map<string, string>, option: (typeof OPTION_NAMES)[number]): string {
  const value = options.get(option);
  if (!value) throw new CliUsageError(`Missing required option ${option}`);
  return value;
}

export function parseArgs(rawArgs: string[]): CliArgs {
  const args = rawArgs.filter((argument) => argument !== '--');
  if (args.includes('--apply')) {
    throw new CliUsageError('--apply is forbidden: this command is permanently audit-only');
  }
  if (args.includes('--help')) {
    throw new CliUsageError('help');
  }

  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (!OPTION_NAMES.includes(option as (typeof OPTION_NAMES)[number])) {
      throw new CliUsageError(`Unknown argument: ${option}`);
    }
    if (!value || value.startsWith('--')) throw new CliUsageError(`${option} requires a value`);
    if (options.has(option)) throw new CliUsageError(`${option} may only be specified once`);
    options.set(option, value);
  }

  const outputPath = requireOption(options, '--output');
  if (outputPath === '-' || outputPath === '/dev/stdout' || outputPath === '/proc/self/fd/1') {
    throw new CliUsageError('--output must be a new regular file, not stdout');
  }
  const policyId = requireOption(options, '--policy-id');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{2,127}$/.test(policyId)) {
    throw new CliUsageError('--policy-id must be a 3-128 character non-secret slug');
  }

  const policy: AuditPolicy = {
    policyId,
    liveOldCodeActiveThroughEpochSeconds: parseInstant(
      '--live-old-code-active-through',
      requireOption(options, '--live-old-code-active-through'),
    ),
    liveFixedCodeActiveFromEpochSeconds: parseInstant(
      '--live-fixed-code-active-from',
      requireOption(options, '--live-fixed-code-active-from'),
    ),
    jsonOldCodeActiveThroughEpochSeconds: parseInstant(
      '--json-old-code-active-through',
      requireOption(options, '--json-old-code-active-through'),
    ),
    jsonFixedCodeActiveFromEpochSeconds: parseInstant(
      '--json-fixed-code-active-from',
      requireOption(options, '--json-fixed-code-active-from'),
    ),
    originWritersActiveFromEpochSeconds: parseInstant(
      '--origin-writers-active-from',
      requireOption(options, '--origin-writers-active-from'),
    ),
    nativeSafeGenerationActiveFromEpochSeconds: parseInstant(
      '--native-safe-generation-active-from',
      requireOption(options, '--native-safe-generation-active-from'),
    ),
  };

  if (policy.liveOldCodeActiveThroughEpochSeconds >= policy.liveFixedCodeActiveFromEpochSeconds) {
    throw new CliUsageError(
      '--live-old-code-active-through must precede --live-fixed-code-active-from; the gap is the abstained rollout window',
    );
  }
  if (policy.jsonOldCodeActiveThroughEpochSeconds >= policy.jsonFixedCodeActiveFromEpochSeconds) {
    throw new CliUsageError(
      '--json-old-code-active-through must precede --json-fixed-code-active-from; the gap is the abstained rollout window',
    );
  }
  if (policy.nativeSafeGenerationActiveFromEpochSeconds < policy.originWritersActiveFromEpochSeconds) {
    throw new CliUsageError('--native-safe-generation-active-from must not precede --origin-writers-active-from');
  }
  return { outputPath, policy };
}

export function helpText(): string {
  return `Usage:
  vp run db:audit-legacy-timestamps -- \\
    --output /secure/new-report.jsonl \\
    --policy-id verified-deploy-record-YYYYMMDD \\
    --live-old-code-active-through <ISO-with-offset> \\
    --live-fixed-code-active-from <ISO-with-offset> \\
    --json-old-code-active-through <ISO-with-offset> \\
    --json-fixed-code-active-from <ISO-with-offset> \\
    --origin-writers-active-from <ISO-with-offset> \\
    --native-safe-generation-active-from <ISO-with-offset>

The live-pull and JSON code instants must come from deployment evidence, not Git
commit timestamps. JSON fixed-code evidence is anchored by the deployed build
containing 79185b916800b866173da01e4ec34743b0015218; the July live-pull fixes do
not define the start of JSON safety. The origin-writer instant must be after
migration 0156 completed and all old writers were retired. Each open rollout
interval is uncertain and always abstains. There is intentionally no --apply
mode and no stdout mode. The native safe-save instant must be after every active
native writer was verified safe or retired, including the still-active legacy
web saveAscent path whose shared-normalizer source fix is
cdf1406dfb53f1865513fd005d39b13f469a74e1. A native row can support evidence
only when it was created at or after that instant and created_at exactly equals
updated_at; pre-origin, pre-safe, edited, or otherwise unverifiable native rows
stay ambiguity-only. Aurora candidates without a sync stamp rollout-abstain;
Aurora candidates or Kilter anchors edited after their source sync, and Kilter
anchors without a sync stamp, also stay ambiguity-only. JSON candidates must
retain their synthetic id and exact import-owned updated/sync stamps; claimed or
otherwise unverifiable JSON rows never support proposals or controls.`;
}

function pathIsWithin(parentPath: string, childPath: string): boolean {
  const relativePath = relative(parentPath, childPath);
  return (
    relativePath === '' || (!relativePath.startsWith(`..${sep}`) && relativePath !== '..' && !isAbsolute(relativePath))
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function validateOutputPath(rawOutputPath: string, cwd = process.cwd()): Promise<string> {
  const outputPath = resolve(cwd, rawOutputPath);
  if (await pathExists(outputPath)) {
    const outputState = await lstat(outputPath);
    throw new CliUsageError(
      outputState.isSymbolicLink()
        ? `Refusing symlink output path: ${outputPath}`
        : `Refusing existing output path: ${outputPath}`,
    );
  }

  const outputParent = dirname(outputPath);
  await access(outputParent, fsConstants.W_OK);
  const realParent = await realpath(outputParent);
  if (realParent !== resolve(outputParent)) {
    throw new CliUsageError(`Refusing output beneath a symlinked directory: ${outputParent}`);
  }

  // Probe from the resolved output parent, not the caller's cwd: an absolute
  // output may belong to a different repository. Only Git's specific
  // "not a repository" result is safe to treat as untracked; every other
  // failure is indeterminate and therefore refused.
  const gitEnvironment = gitProbeEnvironment();
  const repositoryProbe = spawnSync('git', ['--literal-pathspecs', 'rev-parse', '--show-toplevel'], {
    cwd: realParent,
    env: gitEnvironment,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (repositoryProbe.error || repositoryProbe.signal !== null || repositoryProbe.status === null) {
    throw new CliUsageError(`Could not determine Git tracking status for output path: ${outputPath}`);
  }
  if (repositoryProbe.status !== 0) {
    const outsideRepository =
      /^fatal: not a git repository \(or any (?:of the parent directories|parent up to mount point)/i.test(
        repositoryProbe.stderr,
      );
    if (repositoryProbe.status === 128 && outsideRepository) return outputPath;
    throw new CliUsageError(`Could not determine Git tracking status for output path: ${outputPath}`);
  }

  const repositoryRootOutput = repositoryProbe.stdout.trim();
  if (!repositoryRootOutput) {
    throw new CliUsageError(`Could not determine Git tracking status for output path: ${outputPath}`);
  }
  const repositoryRoot = resolve(repositoryRootOutput);
  if (!pathIsWithin(repositoryRoot, outputPath)) {
    throw new CliUsageError(`Could not determine Git tracking status for output path: ${outputPath}`);
  }
  const repositoryRelativePath = relative(repositoryRoot, outputPath);
  const trackedProbe = spawnSync(
    'git',
    ['--literal-pathspecs', 'ls-files', '--error-unmatch', '--', repositoryRelativePath],
    {
      cwd: repositoryRoot,
      env: gitEnvironment,
      encoding: 'utf8',
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  );
  if (trackedProbe.error || trackedProbe.signal !== null || trackedProbe.status === null) {
    throw new CliUsageError(`Could not determine Git tracking status for output path: ${outputPath}`);
  }
  if (trackedProbe.status === 0) {
    throw new CliUsageError(`Refusing tracked output path: ${outputPath}`);
  }
  if (trackedProbe.status !== 1) {
    throw new CliUsageError(`Could not determine Git tracking status for output path: ${outputPath}`);
  }
  return outputPath;
}

export type ArtifactSink = {
  writeCanonicalRecord(record: Record<string, unknown>): Promise<void>;
};

export async function writeAuditArtifact(
  rawOutputPath: string,
  producer: (sink: ArtifactSink) => Promise<Record<string, unknown>>,
  options: { cwd?: string; completedAt?: () => string } = {},
): Promise<{ outputPath: string; digest: string }> {
  const outputPath = await validateOutputPath(rawOutputPath, options.cwd);
  const partialPath = resolve(dirname(outputPath), `.${basename(outputPath)}.${process.pid}.${randomUUID()}.partial`);
  const file = await open(
    partialPath,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0),
    0o600,
  );
  const recordsHash = createHash('sha256');
  let published = false;

  try {
    const sink: ArtifactSink = {
      async writeCanonicalRecord(record) {
        assertPrivacySafeRecord(record);
        const line = canonicalJson(record);
        recordsHash.update(`${line}\n`);
        await file.writeFile(`${line}\n`, 'utf8');
      },
    };
    const runtimeFields = await producer(sink);
    const digest = recordsHash.digest('hex');
    const digestRecord = canonicalJson({ algorithm: 'sha256', digest, type: 'records_digest' });
    await file.writeFile(`${digestRecord}\n`, 'utf8');
    assertPrivacySafeRecord(runtimeFields);
    const runtimeFooter = canonicalJson({
      ...runtimeFields,
      completed_at: (options.completedAt ?? (() => new Date().toISOString()))(),
      type: 'runtime_footer',
    });
    await file.writeFile(`${runtimeFooter}\n`, 'utf8');
    await file.sync();
    await file.close();

    // Hard-link publication is atomic and fails rather than replacing a path
    // created after validation. The partial inode is never visible at the
    // requested output name until every byte has been synced.
    await link(partialPath, outputPath);
    published = true;
    await unlink(partialPath);
    return { outputPath, digest };
  } catch (error: unknown) {
    await file.close().catch(() => undefined);
    await unlink(partialPath).catch(() => undefined);
    if (published) await unlink(outputPath).catch(() => undefined);
    throw error;
  }
}

export type DatabaseAuditMetadata = {
  snapshot: string;
  schemaSha256: string;
  serverVersion: string;
  transactionIsolation: string;
  transactionReadOnly: string;
  transactionDeferrable: string;
  timeZone: string;
};

export type AuditCounters = {
  scannedRows: number;
  groups: number;
  anchors: number;
  edges: number;
  correctionEvidence: number;
  postFixInvariantViolations: number;
  alignedControls: number;
  ambiguousAbstentions: number;
  heuristicOnlyAnchorAbstentions: number;
  candidateTimestampUnverifiedAbstentions: number;
  kilterTimestampUnverifiedAnchorAbstentions: number;
  nativeTimestampUnverifiedAnchorAbstentions: number;
  noAnchorAbstentions: number;
  rolloutUncertainAbstentions: number;
};

function emptyCounters(): AuditCounters {
  return {
    scannedRows: 0,
    groups: 0,
    anchors: 0,
    edges: 0,
    correctionEvidence: 0,
    postFixInvariantViolations: 0,
    alignedControls: 0,
    ambiguousAbstentions: 0,
    heuristicOnlyAnchorAbstentions: 0,
    candidateTimestampUnverifiedAbstentions: 0,
    kilterTimestampUnverifiedAnchorAbstentions: 0,
    nativeTimestampUnverifiedAnchorAbstentions: 0,
    noAnchorAbstentions: 0,
    rolloutUncertainAbstentions: 0,
  };
}

function asFiniteNumber(value: unknown, field: string): number {
  const numericValue = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numericValue)) throw new Error(`Database returned invalid ${field}`);
  return numericValue;
}

function asNullableFiniteNumber(value: unknown, field: string): number | null {
  return value === null || value === undefined ? null : asFiniteNumber(value, field);
}

function asBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`Database returned invalid ${field}`);
  return value;
}

const ORIGINS = new Set<TickOrigin>(['native', 'aurora_pull', 'kilter_pull', 'json_import']);
const STATUSES = new Set<TickStatus>(['flash', 'send', 'attempt']);

export function parseDatabaseRow(row: Record<string, unknown>): AuditTick {
  const origin = String(row.origin) as TickOrigin;
  const status = String(row.status) as TickStatus;
  if (!ORIGINS.has(origin)) throw new Error(`Unexpected tick origin: ${String(row.origin)}`);
  if (!STATUSES.has(status)) throw new Error(`Unexpected tick status: ${String(row.status)}`);
  return {
    id: String(row.id),
    uuid: String(row.uuid),
    userId: String(row.userId),
    boardType: String(row.boardType),
    climbUuid: String(row.climbUuid),
    angle: asFiniteNumber(row.angle, 'angle'),
    isMirror: row.isMirror === true,
    origin,
    status,
    attemptCount: asFiniteNumber(row.attemptCount, 'attemptCount'),
    climbedAtEpochSeconds: asFiniteNumber(row.climbedAtEpochSeconds, 'climbedAtEpochSeconds'),
    createdAtEpochSeconds: asFiniteNumber(row.createdAtEpochSeconds, 'createdAtEpochSeconds'),
    updatedAtEpochSeconds: asFiniteNumber(row.updatedAtEpochSeconds, 'updatedAtEpochSeconds'),
    createdAtEqualsUpdatedAt: asBoolean(row.createdAtEqualsUpdatedAt, 'createdAtEqualsUpdatedAt'),
    auroraSyncedAtEpochSeconds: asNullableFiniteNumber(row.auroraSyncedAtEpochSeconds, 'auroraSyncedAtEpochSeconds'),
    auroraIdIsSyntheticJson: row.auroraIdIsSyntheticJson === true,
    kilterSyncedAtEpochSeconds: asNullableFiniteNumber(row.kilterSyncedAtEpochSeconds, 'kilterSyncedAtEpochSeconds'),
    kilterDetachedAtEpochSeconds: asNullableFiniteNumber(
      row.kilterDetachedAtEpochSeconds,
      'kilterDetachedAtEpochSeconds',
    ),
  };
}

function incrementClassification(counters: AuditCounters, result: CandidateGraphResult): void {
  switch (result.classification) {
    case 'correction_evidence':
      counters.correctionEvidence += 1;
      break;
    case 'post_fix_invariant_violation':
      counters.postFixInvariantViolations += 1;
      break;
    case 'aligned_control':
      counters.alignedControls += 1;
      break;
    case 'ambiguous_abstention':
      counters.ambiguousAbstentions += 1;
      break;
    case 'heuristic_only_anchor_abstention':
      counters.heuristicOnlyAnchorAbstentions += 1;
      break;
    case 'candidate_timestamp_unverified_abstention':
      counters.candidateTimestampUnverifiedAbstentions += 1;
      break;
    case 'kilter_timestamp_unverified_anchor_abstention':
      counters.kilterTimestampUnverifiedAnchorAbstentions += 1;
      break;
    case 'native_timestamp_unverified_anchor_abstention':
      counters.nativeTimestampUnverifiedAnchorAbstentions += 1;
      break;
    case 'no_anchor_abstention':
      counters.noAnchorAbstentions += 1;
      break;
    case 'rollout_uncertain_abstention':
      counters.rolloutUncertainAbstentions += 1;
      break;
  }
}

function detailedEvidenceRecord(
  result: CandidateGraphResult,
  anchors: AuditTick[],
  policy: AuditPolicy,
  pseudonymSecret: Uint8Array,
): Record<string, unknown> | null {
  // No-anchor and rollout-uncertain rows are represented only by privacy-
  // redacted aggregates. A clean heuristic or timestamp-unverified candidate
  // or anchor edge is emitted so reviewers can see why it abstained, but it
  // never contributes a proposal or control violation.
  if (result.classification === 'no_anchor_abstention' || result.classification === 'rollout_uncertain_abstention') {
    return null;
  }
  const candidate = result.candidate;
  const base: Record<string, unknown> = {
    angle: candidate.angle,
    board_type: candidate.boardType,
    candidate_degree: result.candidateDegree,
    candidate_key: pseudonymize(pseudonymSecret, 'tick', candidate.uuid),
    candidate_origin: candidate.origin,
    classification: result.classification,
    climb_key: pseudonymize(pseudonymSecret, 'climb', candidate.climbUuid),
    cohort: result.candidateClass.cohort,
    candidate_timestamp_evidence: candidateTimestampEvidence(candidate),
    origin_evidence: originEvidence(candidate, policy),
    reciprocal: result.reciprocal,
    type: 'candidate_evidence',
    user_key: pseudonymize(pseudonymSecret, 'user', candidate.userId),
  };
  if (!result.edge) return base;
  const anchor = anchors[result.edge.anchorIndex];
  return {
    ...base,
    anchor_climbed_at: epochSecondsToIso(anchor.climbedAtEpochSeconds),
    anchor_key: pseudonymize(pseudonymSecret, 'tick', anchor.uuid),
    anchor_origin: anchor.origin,
    anchor_origin_evidence: originEvidence(anchor, policy),
    anchor_timestamp_evidence: anchorTimestampEvidence(anchor, policy),
    inferred_offset_seconds: result.edge.offsetSeconds,
    original_climbed_at: epochSecondsToIso(candidate.climbedAtEpochSeconds),
    raw_delta_seconds: result.edge.offsetSeconds + result.edge.residualSeconds,
    residual_seconds: result.edge.residualSeconds,
    target_climbed_at: epochSecondsToIso(result.edge.targetEpochSeconds),
  };
}

function redactedCounters(counters: AuditCounters): Record<string, number | '<5'> {
  return Object.fromEntries(Object.entries(counters).map(([name, count]) => [name, redactSmallCell(count)])) as Record<
    string,
    number | '<5'
  >;
}

export function buildAuditSummary(counters: AuditCounters): Record<string, unknown> {
  const proposalsSuppressed = counters.postFixInvariantViolations > 0;
  return {
    counts: redactedCounters(counters),
    effective_correction_proposals: proposalsSuppressed ? 0 : redactSmallCell(counters.correctionEvidence),
    evidence_only: true,
    post_fix_control_invariant: proposalsSuppressed ? 'failed' : 'passed',
    proposals_suppressed: proposalsSuppressed,
    type: 'audit_summary',
  };
}

async function readMetadata(connection: postgres.ReservedSql): Promise<DatabaseAuditMetadata> {
  const [state] = await connection.unsafe<Array<Record<string, unknown>>>(`
    SELECT
      pg_current_snapshot()::text AS "snapshot",
      current_setting('server_version_num') AS "serverVersion",
      current_setting('transaction_isolation') AS "transactionIsolation",
      current_setting('transaction_read_only') AS "transactionReadOnly",
      current_setting('transaction_deferrable') AS "transactionDeferrable",
      current_setting('TimeZone') AS "timeZone"
  `);
  if (!state) throw new Error('Could not read PostgreSQL snapshot settings');
  const metadata = {
    snapshot: String(state.snapshot),
    serverVersion: String(state.serverVersion),
    transactionIsolation: String(state.transactionIsolation),
    transactionReadOnly: String(state.transactionReadOnly),
    transactionDeferrable: String(state.transactionDeferrable),
    timeZone: String(state.timeZone),
    schemaSha256: '',
  };
  if (
    metadata.transactionIsolation !== 'serializable' ||
    metadata.transactionReadOnly !== 'on' ||
    metadata.transactionDeferrable !== 'on' ||
    metadata.timeZone !== 'UTC'
  ) {
    throw new Error(`Unsafe audit transaction settings: ${canonicalJson(metadata)}`);
  }

  const schemaRows = await connection.unsafe<Array<Record<string, unknown>>>(`
    SELECT column_name AS "columnName", data_type AS "dataType", udt_name AS "udtName", is_nullable AS "nullable"
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'boardsesh_ticks'
    ORDER BY ordinal_position
  `);
  const requiredColumns = new Set([
    'id',
    'uuid',
    'user_id',
    'board_type',
    'climb_uuid',
    'angle',
    'is_mirror',
    'origin',
    'status',
    'attempt_count',
    'climbed_at',
    'created_at',
    'updated_at',
    'aurora_id',
    'aurora_synced_at',
    'kilter_synced_at',
    'kilter_detached_at',
  ]);
  for (const row of schemaRows) requiredColumns.delete(String(row.columnName));
  if (requiredColumns.size > 0)
    throw new Error(`boardsesh_ticks schema is missing: ${[...requiredColumns].join(', ')}`);

  const expectedSchema = new Map<string, { dataType: string; udtName?: string }>([
    ['id', { dataType: 'bigint' }],
    ['uuid', { dataType: 'text' }],
    ['user_id', { dataType: 'text' }],
    ['board_type', { dataType: 'text' }],
    ['climb_uuid', { dataType: 'text' }],
    ['angle', { dataType: 'integer' }],
    ['is_mirror', { dataType: 'boolean' }],
    ['origin', { dataType: 'USER-DEFINED', udtName: 'tick_origin' }],
    ['status', { dataType: 'USER-DEFINED', udtName: 'tick_status' }],
    ['attempt_count', { dataType: 'integer' }],
    ['climbed_at', { dataType: 'timestamp without time zone' }],
    ['created_at', { dataType: 'timestamp without time zone' }],
    ['updated_at', { dataType: 'timestamp without time zone' }],
    ['aurora_id', { dataType: 'text' }],
    ['aurora_synced_at', { dataType: 'timestamp without time zone' }],
    ['kilter_synced_at', { dataType: 'timestamp without time zone' }],
    ['kilter_detached_at', { dataType: 'timestamp without time zone' }],
  ]);
  for (const row of schemaRows) {
    const columnName = String(row.columnName);
    const expected = expectedSchema.get(columnName);
    if (!expected) continue;
    if (row.dataType !== expected.dataType || (expected.udtName && row.udtName !== expected.udtName)) {
      throw new Error(`boardsesh_ticks.${columnName} has an unexpected database type; audit aborted`);
    }
  }
  metadata.schemaSha256 = sha256Hex(canonicalJson(schemaRows));
  return metadata;
}

export async function runDatabaseAudit(
  databaseUrl: string,
  policy: AuditPolicy,
  sink: ArtifactSink,
  pseudonymSecret: Uint8Array,
  onMetadata?: (metadata: DatabaseAuditMetadata) => Promise<void>,
): Promise<{ counters: AuditCounters; metadata: DatabaseAuditMetadata }> {
  const client = postgres(databaseUrl, { max: 1, prepare: false, idle_timeout: 5 });
  const connection = await client.reserve().catch(async (error: unknown) => {
    await client.end().catch(() => undefined);
    throw error;
  });
  const counters = emptyCounters();
  let transactionOpen = false;
  let currentGroupKey: string | null = null;
  let currentGroup: AuditTick[] = [];

  const flushGroup = async (): Promise<void> => {
    if (currentGroup.length === 0) return;
    counters.groups += 1;
    const analysis = analyzeTickGroup(currentGroup, policy);
    counters.anchors += analysis.anchors.length;
    counters.edges += analysis.edgeCount;
    for (const result of analysis.candidates) {
      incrementClassification(counters, result);
      const record = detailedEvidenceRecord(result, analysis.anchors, policy, pseudonymSecret);
      if (record) await sink.writeCanonicalRecord(record);
    }
    currentGroup = [];
  };

  try {
    await connection.unsafe('BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE READ ONLY DEFERRABLE');
    transactionOpen = true;
    await connection.unsafe(`SET LOCAL TIME ZONE 'UTC'`);
    const metadata = await readMetadata(connection);
    await onMetadata?.(metadata);

    await connection.unsafe(AUDIT_SCAN_QUERY).cursor(AUDIT_CURSOR_ROWS, async (databaseRows) => {
      for (const databaseRow of databaseRows) {
        const tick = parseDatabaseRow(databaseRow as Record<string, unknown>);
        counters.scannedRows += 1;
        const nextGroupKey = groupKey(tick);
        if (currentGroupKey !== null && nextGroupKey !== currentGroupKey) await flushGroup();
        currentGroupKey = nextGroupKey;
        currentGroup.push(tick);
        if (currentGroup.length > MAX_ROWS_PER_NATURAL_KEY) {
          throw new Error(`Natural-key group exceeded the ${MAX_ROWS_PER_NATURAL_KEY}-row safety bound; audit aborted`);
        }
      }
    });
    await flushGroup();
    await connection.unsafe('ROLLBACK');
    transactionOpen = false;
    return { counters, metadata };
  } finally {
    if (transactionOpen) await connection.unsafe('ROLLBACK').catch(() => undefined);
    connection.release();
    await client.end();
  }
}

async function resolveDatabaseUrl(databaseUrl: string | undefined): Promise<string> {
  if (databaseUrl) return databaseUrl;
  // Keep dotenv loading and database configuration entirely off --help and
  // invalid-output paths. Output validation and exclusive staging happen
  // before this dynamic import runs.
  const { getScriptDatabaseUrl } = await import('./db-connection.js');
  return getScriptDatabaseUrl();
}

export async function runAuditCommand(cliArgs: CliArgs, databaseUrl?: string): Promise<string> {
  const startedAt = Date.now();
  const pseudonymSecret = randomBytes(32);
  const pseudonymScope = pseudonymize(pseudonymSecret, 'scope', 'legacy-timestamp-audit');
  const policyRecord = {
    ...cliArgs.policy,
    jsonOldCodeActiveThroughEpochSeconds: epochSecondsToIso(cliArgs.policy.jsonOldCodeActiveThroughEpochSeconds),
    jsonFixedCodeActiveFromEpochSeconds: epochSecondsToIso(cliArgs.policy.jsonFixedCodeActiveFromEpochSeconds),
    liveFixedCodeActiveFromEpochSeconds: epochSecondsToIso(cliArgs.policy.liveFixedCodeActiveFromEpochSeconds),
    liveOldCodeActiveThroughEpochSeconds: epochSecondsToIso(cliArgs.policy.liveOldCodeActiveThroughEpochSeconds),
    nativeSafeGenerationActiveFromEpochSeconds: epochSecondsToIso(
      cliArgs.policy.nativeSafeGenerationActiveFromEpochSeconds,
    ),
    originWritersActiveFromEpochSeconds: epochSecondsToIso(cliArgs.policy.originWritersActiveFromEpochSeconds),
  };
  const policySha256 = sha256Hex(canonicalJson(policyRecord));

  const { outputPath } = await writeAuditArtifact(cliArgs.outputPath, async (sink) => {
    const resolvedDatabaseUrl = await resolveDatabaseUrl(databaseUrl);
    const { counters } = await runDatabaseAudit(
      resolvedDatabaseUrl,
      cliArgs.policy,
      sink,
      pseudonymSecret,
      async (metadata) => {
        // Snapshot and schema provenance are only available after BEGIN. Emit
        // the header as soon as they are verified, before the cursor can emit
        // any evidence records.
        await sink.writeCanonicalRecord({
          format_version: AUDIT_FORMAT_VERSION,
          mode: 'audit_only_evidence',
          policy: policyRecord,
          policy_sha256: policySha256,
          policy_version: AUDIT_POLICY_VERSION,
          privacy: {
            cross_run_pseudonym_stability: false,
            identifiers: 'run_scoped_hmac_sha256_24',
            pseudonym_scope: pseudonymScope,
            small_cell_threshold: SMALL_CELL_THRESHOLD,
          },
          provenance: {
            query_sha256: AUDIT_QUERY_SHA256,
            schema_sha256: metadata.schemaSha256,
            snapshot: metadata.snapshot,
            timestamp_normalizer_lineage: {
              explicit_offset_suffixes_fixed: EXPLICIT_OFFSET_SUFFIX_FIX_SOURCE_REVISION,
              fixed_json_import_moved: JSON_IMPORT_MOVE_SOURCE_REVISION,
              json_bug_introduced: JSON_BUG_INTRO_SOURCE_REVISION,
              json_deployment_evidence_anchor: JSON_NAIVE_UTC_FIX_SOURCE_REVISION,
              json_naive_utc_fixed: JSON_NAIVE_UTC_FIX_SOURCE_REVISION,
              legacy_web_save_ascent_shared_normalizer_adopted: LEGACY_WEB_SAVE_ASCENT_NORMALIZER_FIX_SOURCE_REVISION,
              live_pull_fixed_and_shared_normalizer_extracted: LIVE_PULL_SHARED_NORMALIZER_FIX_SOURCE_REVISION,
            },
          },
          safety: {
            artifact_is_executable: false,
            aurora_candidate_requires_updated_at_not_after_sync: true,
            created_at_used_as_json_import_time: false,
            json_candidate_requires_exact_synthetic_import_provenance: true,
            kilter_anchor_requires_updated_at_not_after_sync: true,
            native_anchor_requires_created_at_equals_updated_at: true,
            records_digest_reproducible_across_runs: false,
            records_digest_scope: 'single_artifact_integrity',
            per_user_offset_extrapolation: false,
            transaction: {
              deferrable: metadata.transactionDeferrable,
              isolation: metadata.transactionIsolation,
              read_only: metadata.transactionReadOnly,
              time_zone: metadata.timeZone,
            },
          },
          server_version: metadata.serverVersion,
          type: 'audit_header',
        });
      },
    );
    await sink.writeCanonicalRecord(buildAuditSummary(counters));
    return {
      duration_ms: Date.now() - startedAt,
      policy_sha256: policySha256,
      query_sha256: AUDIT_QUERY_SHA256,
      run_id: randomUUID(),
    };
  });
  return outputPath;
}

async function main(): Promise<void> {
  try {
    const args = parseArgs(process.argv.slice(2));
    const outputPath = await runAuditCommand(args);
    console.info(`[legacy-timestamp-audit] Wrote audit-only evidence to ${outputPath}`);
  } catch (error: unknown) {
    if (error instanceof CliUsageError) {
      if (error.message !== 'help') console.error(`[legacy-timestamp-audit] ${error.message}`);
      console.error(helpText());
      process.exitCode = error.message === 'help' ? 0 : 2;
      return;
    }
    console.error(`[legacy-timestamp-audit] failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

const isDirectRun = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (isDirectRun) void main();
