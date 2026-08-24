/**
 * #3909 — READ-ONLY blast-radius report for legacy ticks whose `climbed_at`
 * holds the climber's local wall clock relabelled as UTC.
 *
 * THIS SCRIPT NEVER WRITES. There is no `--apply` flag in this file, and the
 * connection is opened through `createReadOnlyScriptDb`, which starts every
 * transaction with `default_transaction_read_only=on`. That is a POSTGRES
 * guarantee (SQLSTATE 25006 on any write), not a convention — so it is safe to
 * point at a replica or a restored snapshot. The corrective counterpart lives
 * in backfill-mislabeled-tick-timezones.ts and refuses to write without an
 * explicit `--apply`.
 *
 * Usage:
 *   vp run db:report-tick-timezones
 *   vp run db:report-tick-timezones -- --origin json_import,aurora_pull --out ./report.json
 *
 * Options:
 *   --origin <csv>  Suspect origins to classify. Default: json_import.
 *                   Accepts json_import, aurora_pull, native_pre_cutoff.
 *   --user <id>     Restrict the whole report to one climber (canary sizing).
 *   --out <file>    Per-tick decision set. Default ./tick-timezone-report-<date>.json.
 *   --batch <n>     Keyset page size. Default 20000.
 *
 * ## What the report is for
 *
 * Nothing in a single row records which zone its naive timestamp meant, so the
 * only evidence is cross-source agreement. The report measures that agreement
 * and — this is the point — measures whether the bug is still LIVE, before
 * anybody proposes rewriting a quarter of a million rows.
 *
 * Two mechanisms are on the table (see #3909):
 *
 *   A. server-local parse — one FLEET-WIDE offset, from the pre-PR4
 *      `new Date("2024-01-15 10:30:00").toISOString()` that V8 resolves in the
 *      server's zone. Real for pre-PR4 `aurora_pull` and pre-PR4 web-written
 *      `native`. No `TZ=` is set in any workflow or Dockerfile in this repo and
 *      containers default to UTC, which predicts this was a production NO-OP —
 *      section (f) is what tests that prediction instead of assuming it.
 *   B. Aurora's naive string is the CLIMBER's local wall clock, relabelled UTC
 *      by us — a PER-USER offset, which is what #3909's measured distribution
 *      (−1h×799, +8h×354, −10h×319, +5h×153) actually looks like. Mechanism B
 *      is NOT bounded by the PR4 cutoff, so section (d) checks whether the
 *      post-cutoff half still shows per-user offsets. If it does, the writer is
 *      still producing shifted rows today and no correction may run first.
 *
 * Section (e) is the gate that matters most: it cross-checks the two honest
 * anchor families against EACH OTHER. If `kilter_pull` and post-cutoff `native`
 * do not agree at ≈0 on ascents they share, the correction DIRECTION is
 * unproven and the whole plan stops.
 */

import { writeFileSync } from 'fs';
import { pathToFileURL } from 'node:url';
import { and, asc, eq, gt, sql } from 'drizzle-orm';

import { createReadOnlyScriptDb, describeDatabaseHost, getScriptDatabaseUrl } from './db-connection.js';
import { boardseshTicks } from '../src/schema/app/ascents.js';
import { boardClimbAliases } from '../src/schema/boards/unified.js';
import {
  classifyAllSuspects,
  calendarQuarterOf,
  naturalKeyOf,
  perKeyClosestDeltasMs,
  roundOffsetSeconds,
  type AnchorTick,
  type ClassifiedSuspect,
  type SuspectTick,
} from '../src/queries/index.js';

/**
 * A `native` tick is only an honest-UTC anchor once #3555 (merge e6c7a3287,
 * 2026-07-08 19:43:23 +1000 = 2026-07-09T09:43:23Z) was actually DEPLOYED.
 * The merge instant is not the deploy instant, so a 24h buffer is added and
 * stated here rather than buried: widen it if the deploy log says otherwise.
 */
export const NATIVE_ANCHOR_CUTOFF = '2026-07-10T09:43:23Z';
const NATIVE_ANCHOR_CUTOFF_MS = Date.parse(NATIVE_ANCHOR_CUTOFF);

export type SuspectOriginSelector = 'json_import' | 'aurora_pull' | 'native_pre_cutoff';
const SUSPECT_ORIGIN_SELECTORS: readonly SuspectOriginSelector[] = ['json_import', 'aurora_pull', 'native_pre_cutoff'];

export type ReportArgs = {
  origins: SuspectOriginSelector[];
  userId: string | null;
  outPath: string;
  batchSize: number;
};

export class ArgError extends Error {}

/**
 * Pure arg parsing so both scripts validate identically and BEFORE a connection
 * is opened. A garbage `--batch` that silently coerced to NaN would page zero
 * rows and print a clean, completely wrong "nothing to fix" report.
 */
export function parseReportArgs(argv: readonly string[], today: string): ReportArgs {
  const args = argv[0] === '--' ? argv.slice(1) : [...argv];
  const value = (name: string): string | undefined => {
    const index = args.indexOf(name);
    return index === -1 ? undefined : args[index + 1];
  };

  const known = new Set(['--origin', '--user', '--out', '--batch']);
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith('--')) continue;
    if (!known.has(token)) throw new ArgError(`Unknown argument "${token}"`);
    index += 1; // every known flag takes a value
  }

  return {
    origins: parseOriginSelectors(value('--origin')),
    userId: value('--user') ?? null,
    outPath: value('--out') ?? `./tick-timezone-report-${today}.json`,
    batchSize: parseBatchSize(value('--batch')),
  };
}

/** Shared by both scripts so `--origin` can never mean two different things. */
export function parseOriginSelectors(raw: string | undefined): SuspectOriginSelector[] {
  const origins = (raw ?? 'json_import')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (origins.length === 0) throw new ArgError('--origin must name at least one origin');
  for (const origin of origins) {
    if (!SUSPECT_ORIGIN_SELECTORS.includes(origin as SuspectOriginSelector)) {
      throw new ArgError(`--origin must be one of ${SUSPECT_ORIGIN_SELECTORS.join(', ')}; got "${origin}"`);
    }
  }
  return origins as SuspectOriginSelector[];
}

/** Shared by both scripts. Rejects NaN rather than silently paging zero rows. */
export function parseBatchSize(raw: string | undefined): number {
  const batchSize = raw === undefined ? 20_000 : Number(raw);
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new ArgError(`--batch must be a positive integer, got "${raw}"`);
  }
  return batchSize;
}

/** One tick as the audit needs it, with its climb uuid already canonicalised. */
export type AuditTickRow = {
  uuid: string;
  userId: string;
  boardType: string;
  climbUuid: string;
  canonicalClimbUuid: string;
  angle: number;
  status: string;
  origin: string;
  climbedAt: string;
  climbedAtMs: number;
  createdAtMs: number;
  /**
   * COALESCE(aurora_synced_at, updated_at) — the best available proxy for WHEN
   * this row was last written by a sync path, which is what the control cohort
   * splits on.
   *
   * It is a proxy, not the truth, and the imprecision runs one way. A row Aurora
   * has synced carries a real aurora_synced_at. A `json_import` row Aurora never
   * touched falls back to updated_at, which is the import instant for an
   * untouched row but moves forward if the climber ever edited the tick — so an
   * edited legacy row can be counted in the post-cutoff half. That inflates the
   * post-cutoff bucket rather than hiding a problem in it, which is the safe
   * direction for a gate that reads "post-cutoff must be clean".
   */
  syncedAtMs: number;
};

type ScriptDb = ReturnType<typeof createReadOnlyScriptDb>['db'];

/**
 * Keyset-paged fetch over boardsesh_ticks, canonicalising the climb uuid in
 * SQL.
 *
 * The alias join is not cosmetic. `kilter_pull` resolves aliases before writing
 * (`buildLogTickFields(raw, canonical, now)`), while `json_import` and
 * `aurora_pull` store whatever Aurora sent — so joining raw `climb_uuid`
 * silently drops every aliased climb from the suspect↔anchor match and both
 * understates the blast radius and inflates the abstain counts. A miss is
 * self-canonical, which is exactly `resolveCanonicalClimbUuid`'s contract.
 *
 * Keyset on `id` rather than OFFSET: a single 460K-row SELECT is a large
 * server-side sort and, on a replica, a long snapshot to hold open.
 */
export async function fetchAuditTickRows(
  db: ScriptDb,
  options: { userId: string | null; batchSize: number },
): Promise<AuditTickRow[]> {
  const rows: AuditTickRow[] = [];
  let cursor = 0n;

  for (;;) {
    const conditions = [gt(boardseshTicks.id, cursor)];
    if (options.userId) conditions.push(eq(boardseshTicks.userId, options.userId));

    const page = await db
      .select({
        id: boardseshTicks.id,
        uuid: boardseshTicks.uuid,
        userId: boardseshTicks.userId,
        boardType: boardseshTicks.boardType,
        climbUuid: boardseshTicks.climbUuid,
        canonicalClimbUuid: sql<string>`COALESCE(${boardClimbAliases.canonicalUuid}, ${boardseshTicks.climbUuid})`,
        angle: boardseshTicks.angle,
        status: boardseshTicks.status,
        origin: boardseshTicks.origin,
        climbedAt: boardseshTicks.climbedAt,
        createdAt: boardseshTicks.createdAt,
        syncedAt: sql<string>`COALESCE(${boardseshTicks.auroraSyncedAt}, ${boardseshTicks.updatedAt})`,
      })
      .from(boardseshTicks)
      .leftJoin(
        boardClimbAliases,
        and(
          eq(boardClimbAliases.boardType, boardseshTicks.boardType),
          eq(boardClimbAliases.aliasUuid, boardseshTicks.climbUuid),
        ),
      )
      .where(and(...conditions))
      .orderBy(asc(boardseshTicks.id))
      .limit(options.batchSize);

    if (page.length === 0) break;
    for (const row of page) {
      rows.push({
        uuid: row.uuid,
        userId: row.userId,
        boardType: row.boardType,
        climbUuid: row.climbUuid,
        canonicalClimbUuid: row.canonicalClimbUuid,
        angle: row.angle,
        status: row.status,
        origin: row.origin,
        climbedAt: row.climbedAt,
        // Stored as `timestamp` (no zone) but always MEANT as UTC by every
        // writer, so append the Z rather than letting Date.parse guess.
        climbedAtMs: parseNaiveUtc(row.climbedAt),
        createdAtMs: parseNaiveUtc(row.createdAt),
        syncedAtMs: parseNaiveUtc(row.syncedAt),
      });
    }
    cursor = page[page.length - 1].id;
    if (page.length < options.batchSize) break;
  }

  return rows;
}

/**
 * Parse a `timestamp without time zone` string as UTC. postgres.js hands these
 * back as "2024-01-15 10:30:00" (or an ISO string without a zone depending on
 * driver settings); `new Date(...)` would resolve the space form in the
 * SCRIPT's local zone, which is the very bug this report is measuring.
 */
export function parseNaiveUtc(value: string): number {
  const trimmed = value.trim();
  if (trimmed.endsWith('Z') || /[+-]\d{2}:?\d{2}$/.test(trimmed)) return Date.parse(trimmed);
  return Date.parse(`${trimmed.replace(' ', 'T')}Z`);
}

function isAnchorRow(row: AuditTickRow): boolean {
  if (row.origin === 'kilter_pull') return true;
  return row.origin === 'native' && row.createdAtMs >= NATIVE_ANCHOR_CUTOFF_MS;
}

function matchesSuspectSelector(row: AuditTickRow, origins: readonly SuspectOriginSelector[]): boolean {
  if (row.origin === 'json_import') return origins.includes('json_import');
  if (row.origin === 'aurora_pull') return origins.includes('aurora_pull');
  if (row.origin === 'native') {
    return origins.includes('native_pre_cutoff') && row.createdAtMs < NATIVE_ANCHOR_CUTOFF_MS;
  }
  return false;
}

/**
 * Aurora-twin membership, computed in memory as a deliberate SUPERSET of
 * `isDirectAuroraTwin`: same (user, board, RAW climb uuid, angle, status) and
 * byte-identical climbed_at. The real predicate additionally requires both
 * sides to be real aurora_pull rows with payload parity, so this over-counts —
 * and over-counting only produces MORE abstentions, which is the safe
 * direction. Shifting one member of a twin group and not its sibling un-hides
 * a duplicate in the climber's logbook.
 */
function buildAuroraTwinMembership(rows: readonly AuditTickRow[]): Set<string> {
  const groups = new Map<string, string[]>();
  for (const row of rows) {
    const key = `${row.userId} ${row.boardType} ${row.climbUuid} ${row.angle} ${row.status} ${row.climbedAt}`;
    const list = groups.get(key);
    if (list) list.push(row.uuid);
    else groups.set(key, [row.uuid]);
  }
  const members = new Set<string>();
  for (const uuids of groups.values()) {
    if (uuids.length < 2) continue;
    for (const uuid of uuids) members.add(uuid);
  }
  return members;
}

type Histogram = Record<string, number>;

function histogramOf(offsetSeconds: readonly number[]): Histogram {
  const counts = new Map<number, number>();
  for (const seconds of offsetSeconds) counts.set(seconds, (counts.get(seconds) ?? 0) + 1);
  return Object.fromEntries(
    [...counts.entries()].sort((a, b) => a[0] - b[0]).map(([seconds, count]) => [formatOffset(seconds), count]),
  );
}

export function formatOffset(seconds: number): string {
  const sign = seconds < 0 ? '-' : '+';
  const absolute = Math.abs(seconds);
  const hours = Math.floor(absolute / 3600);
  const minutes = Math.floor((absolute % 3600) / 60);
  return `${sign}${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/** Index rows by (user, board, canonical climb, angle) for O(1) anchor lookup. */
function indexByNaturalKey(rows: readonly AuditTickRow[]): Map<string, AuditTickRow[]> {
  const index = new Map<string, AuditTickRow[]>();
  for (const row of rows) {
    const key = `${row.userId} ${row.boardType} ${naturalKeyOf(row)}`;
    const list = index.get(key);
    if (list) list.push(row);
    else index.set(key, [row]);
  }
  return index;
}

/**
 * Closest suspect↔anchor delta for one row, in seconds, or null when the row
 * shares no natural key with any anchor. Positive means the stored value runs
 * AHEAD of the honest instant, i.e. the amount to subtract.
 */
function closestAnchorDeltaSeconds(row: AuditTickRow, anchorIndex: Map<string, AuditTickRow[]>): number | null {
  const anchors = anchorIndex.get(`${row.userId} ${row.boardType} ${naturalKeyOf(row)}`);
  if (!anchors || anchors.length === 0) return null;
  let best: number | null = null;
  for (const anchor of anchors) {
    const delta = row.climbedAtMs - anchor.climbedAtMs;
    if (best === null || Math.abs(delta) < Math.abs(best)) best = delta;
  }
  return best === null ? null : best / 1000;
}

export type TickTimezoneAudit = ReturnType<typeof buildAudit>;

/** Everything the report prints and the backfill decides from, in one pass. */
export function buildAudit(rows: readonly AuditTickRow[], origins: readonly SuspectOriginSelector[]) {
  const anchorRows = rows.filter(isAnchorRow);
  const suspectRows = rows.filter((row) => matchesSuspectSelector(row, origins));
  const anchorIndex = indexByNaturalKey(anchorRows);
  const twinMembers = buildAuroraTwinMembership(rows);

  const anchors: AnchorTick[] = anchorRows.map((row) => ({
    userId: row.userId,
    boardType: row.boardType,
    canonicalClimbUuid: row.canonicalClimbUuid,
    angle: row.angle,
    climbedAtMs: row.climbedAtMs,
    trust: row.origin === 'kilter_pull' ? 'kilter_pull' : 'native',
  }));

  const suspects: SuspectTick[] = suspectRows.map((row) => ({
    uuid: row.uuid,
    userId: row.userId,
    boardType: row.boardType,
    canonicalClimbUuid: row.canonicalClimbUuid,
    angle: row.angle,
    climbedAtMs: row.climbedAtMs,
    origin: row.origin,
    isAuroraTwinMember: twinMembers.has(row.uuid),
  }));

  const decisions = classifyAllSuspects(anchors, suspects);
  const rowByUuid = new Map(suspectRows.map((row) => [row.uuid, row]));

  // (a) row counts by origin — compare against #3909's snapshot to see drift.
  const countsByOrigin: Record<string, number> = {};
  for (const row of rows) countsByOrigin[row.origin] = (countsByOrigin[row.origin] ?? 0) + 1;

  // (b) per-origin anchored vs unanchored.
  const anchorCoverage: Record<string, { withAnchor: number; withoutAnchor: number }> = {};
  // (c)/(f)/(k) offset histograms, sliced several ways from one delta pass.
  const offsetsByOrigin = new Map<string, number[]>();
  const offsetsByCohort = new Map<string, number[]>();
  const perUserOffsets = new Map<string, Set<number>>();

  for (const row of rows) {
    if (isAnchorRow(row)) continue;
    const bucket = (anchorCoverage[row.origin] ??= { withAnchor: 0, withoutAnchor: 0 });
    const delta = closestAnchorDeltaSeconds(row, anchorIndex);
    if (delta === null) {
      bucket.withoutAnchor += 1;
      continue;
    }
    bucket.withAnchor += 1;
    const rounded = roundOffsetSeconds(delta);
    pushTo(offsetsByOrigin, row.origin, rounded);
    // (d) the control cohort: the same origin split around the PR4 deploy.
    const era = row.syncedAtMs >= NATIVE_ANCHOR_CUTOFF_MS ? 'post-cutoff' : 'pre-cutoff';
    pushTo(offsetsByCohort, `${row.origin}/${era}`, rounded);
    const userOffsets = perUserOffsets.get(row.userId) ?? new Set<number>();
    userOffsets.add(rounded);
    perUserOffsets.set(row.userId, userOffsets);
  }

  // (e) anchor vs anchor. The gate: do the two families we call honest agree
  // with EACH OTHER on ascents they share? If not, the direction is unproven.
  const kilterAnchors = anchorRows.filter((row) => row.origin === 'kilter_pull');
  const nativeAnchors = anchorRows.filter((row) => row.origin === 'native');
  const anchorCrossCheck = histogramOf(
    crossFamilyDeltas(kilterAnchors, nativeAnchors).map((delta) => roundOffsetSeconds(delta / 1000)),
  );

  // (g) abstain / verdict breakdown, including the per-row already-correct guard.
  const verdictCounts: Record<string, number> = {};
  const shiftOffsets: number[] = [];
  let createdAtDrift = 0;
  let maxCreatedAtDriftSeconds = 0;
  const affectedKeys = new Set<string>();
  const affectedUsers = new Map<string, number>();

  for (const { suspect, verdict } of decisions) {
    const label = verdict.verdict === 'abstain' ? `abstain:${verdict.reason}` : verdict.verdict;
    verdictCounts[label] = (verdictCounts[label] ?? 0) + 1;
    if (verdict.verdict !== 'shift') continue;
    shiftOffsets.push(verdict.offsetSeconds);
    affectedKeys.add(`${suspect.boardType} ${naturalKeyOf(suspect)}`);
    affectedUsers.set(suspect.userId, (affectedUsers.get(suspect.userId) ?? 0) + 1);
    // (l) created_at drift: syncTicks ships BOTH columns, so a corrected row
    // can end up reading created_at LATER than its own climbed_at.
    const row = rowByUuid.get(suspect.uuid);
    if (row && verdict.correctedMs < row.createdAtMs) {
      createdAtDrift += 1;
      maxCreatedAtDriftSeconds = Math.max(maxCreatedAtDriftSeconds, (row.createdAtMs - verdict.correctedMs) / 1000);
    }
  }

  const aliasResolvedSuspects = suspectRows.filter((row) => row.canonicalClimbUuid !== row.climbUuid).length;
  const multiOffsetUsers = [...perUserOffsets.values()].filter((offsets) => offsets.size > 1).length;

  return {
    generatedAt: new Date().toISOString(),
    nativeAnchorCutoff: NATIVE_ANCHOR_CUTOFF,
    suspectOrigins: [...origins],
    totals: {
      ticks: rows.length,
      anchors: anchorRows.length,
      suspects: suspectRows.length,
      auroraTwinMembers: twinMembers.size,
    },
    // (a)
    countsByOrigin,
    // (b)
    anchorCoverage,
    // (c)
    offsetHistogramByOrigin: Object.fromEntries(
      [...offsetsByOrigin.entries()].map(([origin, offsets]) => [origin, histogramOf(offsets)]),
    ),
    // (d) — THE control cohort. A non-zero post-cutoff histogram means the
    // writer is STILL producing shifted rows and no correction may run yet.
    controlCohort: Object.fromEntries(
      [...offsetsByCohort.entries()].sort().map(([cohort, offsets]) => [cohort, histogramOf(offsets)]),
    ),
    // (e) — the hard gate.
    anchorCrossCheck,
    // (f) — Mechanism A probe: one fleet-wide spike (server-local parse) or a
    // per-user spread (Mechanism B)? `distinctOffsetUsers` separates them.
    mechanismProbe: {
      usersWithAnyOffset: perUserOffsets.size,
      usersWithMoreThanOneOffset: multiOffsetUsers,
      pooledPreCutoffAuroraPull: histogramOf(offsetsByCohort.get('aurora_pull/pre-cutoff') ?? []),
      pooledPreCutoffNative: histogramOf(offsetsByCohort.get('native/pre-cutoff') ?? []),
    },
    // (g)
    verdictCounts,
    shiftOffsetHistogram: histogramOf(shiftOffsets),
    // (h) / (i) / (j)
    blastRadius: {
      auroraTwinSuspects: suspects.filter((suspect) => suspect.isAuroraTwinMember).length,
      affectedStatsKeys: affectedKeys.size,
      affectedUsers: affectedUsers.size,
      maxTicksForOneUser: affectedUsers.size === 0 ? 0 : Math.max(...affectedUsers.values()),
      // Alias effect: how many suspects changed natural key once resolved.
      suspectsBehindAnAlias: aliasResolvedSuspects,
    },
    // (l)
    createdAtDrift: { rows: createdAtDrift, maxSecondsEarlierThanCreatedAt: maxCreatedAtDriftSeconds },
    decisions,
  };
}

function pushTo(target: Map<string, number[]>, key: string, value: number): void {
  const list = target.get(key);
  if (list) list.push(value);
  else target.set(key, [value]);
}

/**
 * Deltas between the two honest anchor families on ascents they share, per
 * climber. Reuses `perKeyClosestDeltasMs` so this cross-check is measured with
 * the exact algorithm the correction itself uses.
 */
function crossFamilyDeltas(left: readonly AuditTickRow[], right: readonly AuditTickRow[]): number[] {
  const byUser = new Map<string, { left: AuditTickRow[]; right: AuditTickRow[] }>();
  for (const row of left) {
    const key = `${row.userId} ${row.boardType}`;
    const entry = byUser.get(key) ?? { left: [], right: [] };
    entry.left.push(row);
    byUser.set(key, entry);
  }
  for (const row of right) {
    const key = `${row.userId} ${row.boardType}`;
    const entry = byUser.get(key) ?? { left: [], right: [] };
    entry.right.push(row);
    byUser.set(key, entry);
  }
  const deltas: number[] = [];
  for (const entry of byUser.values()) {
    if (entry.left.length === 0 || entry.right.length === 0) continue;
    const toSample = (row: AuditTickRow) => ({
      climbUuid: row.canonicalClimbUuid,
      angle: row.angle,
      climbedAtMs: row.climbedAtMs,
    });
    deltas.push(...perKeyClosestDeltasMs(entry.left.map(toSample), entry.right.map(toSample)));
  }
  return deltas;
}

function printSummary(audit: TickTimezoneAudit, outPath: string): void {
  const line = (label: string, body: unknown) => console.log(`  ${label.padEnd(34)} ${JSON.stringify(body)}`);
  console.log('\n#3909 legacy tick-timezone audit — READ ONLY, nothing was written.\n');
  console.log(`  native-anchor cutoff: ${audit.nativeAnchorCutoff} (merge instant + 24h deploy buffer)\n`);

  console.log('(a) rows by origin');
  line('counts', audit.countsByOrigin);
  console.log('(b) suspect anchor coverage');
  line('by origin', audit.anchorCoverage);
  console.log('(c) closest-anchor offset histogram');
  line('by origin', audit.offsetHistogramByOrigin);
  console.log('(d) CONTROL COHORT — split around the PR4 deploy');
  console.log('    a non-zero post-cutoff histogram means the writer is STILL shifting rows.');
  line('by origin/era', audit.controlCohort);
  console.log('(e) ANCHOR CROSS-CHECK — kilter_pull vs post-cutoff native');
  console.log('    must concentrate at +00:00, or the correction direction is unproven.');
  line('deltas', audit.anchorCrossCheck);
  console.log('(f) mechanism probe — fleet-wide (A) vs per-user (B)');
  line('probe', audit.mechanismProbe);
  console.log('(g) verdicts');
  line('counts', audit.verdictCounts);
  line('shift offsets', audit.shiftOffsetHistogram);
  console.log('(h/i/j) blast radius');
  line('blast radius', audit.blastRadius);
  console.log('(l) created_at drift after correction');
  line('drift', audit.createdAtDrift);

  const abstained = Object.entries(audit.verdictCounts)
    .filter(([label]) => label.startsWith('abstain:'))
    .reduce((total, [, count]) => total + count, 0);
  console.log(`\n  RESIDUAL: ${abstained} suspect rows would stay uncorrected by design. A green run is not "fixed".`);
  console.log(`  Per-tick decisions written to ${outPath}\n`);
}

async function main(): Promise<void> {
  const parsed = parseReportArgs(process.argv.slice(2), new Date().toISOString().slice(0, 10));
  const databaseUrl = getScriptDatabaseUrl();
  console.log(
    `[report-tick-timezones] target=${describeDatabaseHost(databaseUrl)} mode=read-only origins=${parsed.origins.join(',')}`,
  );

  const { db, close } = createReadOnlyScriptDb(databaseUrl);
  try {
    const rows = await fetchAuditTickRows(db, { userId: parsed.userId, batchSize: parsed.batchSize });
    const audit = buildAudit(rows, parsed.origins);
    writeFileSync(
      parsed.outPath,
      JSON.stringify(
        {
          ...audit,
          decisions: audit.decisions.map(({ suspect, verdict }: ClassifiedSuspect) => ({
            uuid: suspect.uuid,
            userId: suspect.userId,
            boardType: suspect.boardType,
            canonicalClimbUuid: suspect.canonicalClimbUuid,
            angle: suspect.angle,
            origin: suspect.origin,
            quarter: calendarQuarterOf(suspect.climbedAtMs),
            storedClimbedAt: new Date(suspect.climbedAtMs).toISOString(),
            verdict,
          })),
        },
        null,
        2,
      ),
    );
    printSummary(audit, parsed.outPath);
  } finally {
    await close();
  }
}

const isDirectRun = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;

if (isDirectRun) {
  main().catch((error: unknown) => {
    if (error instanceof ArgError) {
      console.error(`[report-tick-timezones] ${error.message}`);
      process.exit(1);
    }
    console.error('[report-tick-timezones] failed:', error);
    process.exit(1);
  });
}
