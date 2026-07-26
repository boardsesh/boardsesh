/**
 * Repair send ticks whose attempt count was silently floored to 2 by the mobile app.
 *
 * Resolves #3937. The code path was fixed in #3939 (issue #2888); this is the
 * separate decision about the rows already written.
 *
 * Between 2026-05-24 (commit 70cecc589) and that fix, the RN QuickTickBar floored
 * `attemptCount` at 2 for any `send` via `getMinAttempts('send')`. Any climb the
 * climber had touched before derives as `send`, so a one-try repeat — the most
 * common ascent there is — was stored as 2 tries while the picker still displayed
 * 1. Web was never affected (no clamp) and the backend never required `send >= 2`,
 * so only mobile-written rows are suspect.
 *
 * A clamped 1-try send is byte-identical to a genuine 2-try send: the pre-clamp
 * value was never stored, and the analytics event logs the post-clamp number. So
 * this script cannot be perfectly precise. It limits the blast radius two ways:
 *
 *   1. Rows are matched against actual mobile analytics events, so web-written
 *      rows in the same window are never touched.
 *   2. Every change is snapshotted to a JSON file first, and `--revert` restores
 *      from that file exactly.
 *
 * #3937 estimates 70–88% of these rows are wrong, so expect roughly 12–30% of
 * matched rows to be genuine 2-try sends that get flattened. The issue recommends
 * doing nothing; running this is the deliberate call to prefer the common case,
 * and the snapshot is what makes that call reversible.
 *
 * Producing the input file (needs a PostHog personal API key, project 412845):
 *
 *   SELECT
 *     person.properties.email AS email,
 *     properties.climbUuid    AS climb_uuid,
 *     timestamp               AS event_ts
 *   FROM events
 *   WHERE event = 'Quick Tick Saved'
 *     AND properties.$lib = 'posthog-react-native'
 *     AND properties.status = 'send'
 *     AND properties.attemptCount = 2
 *     AND timestamp >= '2026-05-24'
 *     AND timestamp <  '2026-07-26'
 *
 * The upper bound is not optional. It must match `--until`, or the export picks
 * up the real two-try sends mobile started writing again after the fix and this
 * script rewrites them to 1.
 *
 * Save the result as CSV (header row `email,climb_uuid,event_ts`) or as JSONL with
 * those three keys per line.
 *
 * Usage (needs a DB_URL with UPDATE rights — the usual read-only credential can
 * run --dry-run but not the apply step):
 *   vp run db:backfill-clamped-send-attempts -- --events <file> --dry-run
 *   vp run db:backfill-clamped-send-attempts -- --events <file>
 *   vp run db:backfill-clamped-send-attempts -- --revert <snapshot.json>
 *
 * Options:
 *   --events <file>     PostHog export (.csv or .jsonl). Required unless --revert.
 *   --dry-run           Match and report, write nothing.
 *   --revert <file>     Restore attempt counts from a snapshot written by a prior run.
 *   --tolerance-min <n> Minutes of slack when matching climbed_at to the event
 *                       timestamp (default 60).
 *   --since <date>      Inclusive lower bound on climbed_at (default 2026-05-24,
 *                       the day the clamp landed).
 *   --until <date>      Exclusive upper bound on climbed_at (default 2026-07-26,
 *                       the day the fix merged). Must match the export's bound.
 *   --out <file>        Snapshot path (default ./clamped-send-attempts-<since>.json).
 *
 * Safe to re-run: rows already at 1 try simply stop matching.
 */

import { readFileSync, writeFileSync } from 'fs';
import { and, eq, gte, inArray, lt } from 'drizzle-orm';
import { createScriptDb } from './db-connection.js';
import { boardseshTicks } from '../src/schema/app/ascents.js';
import { users } from '../src/schema/auth/users.js';

const CLAMP_LANDED = '2026-05-24';
// The instant PR #3939 merged and the clamp stopped being written. Needs to be
// a timestamp, not a date: the fix landed mid-morning, so a whole-day bound
// would either discard that morning's clamped rows or sweep up the afternoon's
// legitimate ones.
const CLAMP_FIXED = '2026-07-26T06:03:26Z';

const args = process.argv.slice(2);
function flag(name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const eventsPath = flag('--events');
const revertPath = flag('--revert');
const dryRun = args.includes('--dry-run');

// Validate before anything touches the database. This script issues destructive
// UPDATEs, so a malformed flag must stop it rather than silently change what it
// matches: a NaN tolerance would compare false against every row and report a
// clean "0 matched" run that looks like there was nothing to fix.
const toleranceRaw = flag('--tolerance-min');
const toleranceMinutes = toleranceRaw === undefined ? 60 : Number(toleranceRaw);
if (!Number.isFinite(toleranceMinutes) || toleranceMinutes < 0) {
  fail(`--tolerance-min must be a non-negative number, got "${toleranceRaw}"`);
}

// `since` reaches both a SQL bound and the default snapshot filename, so keep it
// to a bare ISO date — "2026/05/24" would otherwise build a path with slashes in
// it and fail late with a confusing ENOENT.
/**
 * Accepts a bare ISO date or a full ISO timestamp and normalises to an instant.
 * A bare date means midnight UTC, so `--since` includes that whole day and
 * `--until` (exclusive) excludes it.
 */
function parseBound(name: string, raw: string): string {
  const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw);
  const normalised = isDateOnly ? `${raw}T00:00:00.000Z` : raw;
  const parsed = Date.parse(normalised);
  if (Number.isNaN(parsed)) {
    fail(`${name} must be an ISO date (YYYY-MM-DD) or timestamp, got "${raw}"`);
  }
  return new Date(parsed).toISOString();
}

const since = parseBound('--since', flag('--since') ?? CLAMP_LANDED);

// Exclusive upper bound. Past the fix, mobile writes real two-try sends again,
// so an unbounded run would rewrite legitimate rows to 1 try forever. Defaults
// to the instant the fix merged; the OTA rollout means some climbers kept
// clamping for a while after that, and those rows simply go unrepaired —
// under-repairing is the safe direction here.
const until = parseBound('--until', flag('--until') ?? CLAMP_FIXED);
if (Date.parse(until) <= Date.parse(since)) {
  fail(`--until (${until}) must be after --since (${since})`);
}

// Date portion only: `since` is a normalised ISO instant, and its colons are
// illegal in Windows filenames.
const outPath = flag('--out') ?? `./clamped-send-attempts-${since.slice(0, 10)}.json`;

type TickEvent = { email: string; climbUuid: string; eventTs: Date };
type SuspectRow = { uuid: string; userId: string; climbUuid: string; climbedAt: string; attemptCount: number };
type SnapshotEntry = { uuid: string; oldAttemptCount: number; newAttemptCount: number; climbedAt: string };
type Snapshot = {
  since: string;
  until: string;
  toleranceMinutes: number;
  writtenAt: string;
  entries: SnapshotEntry[];
};

/** Parses the PostHog export. Accepts JSONL or CSV with a header row. */
function parseEvents(path: string): TickEvent[] {
  const raw = readFileSync(path, 'utf8').trim();
  if (!raw) return [];

  const lines = raw.split('\n').filter((line) => line.trim().length > 0);
  const isJsonl = lines[0].trimStart().startsWith('{');

  if (isJsonl) {
    return lines.map((line, index) => {
      let parsed: Record<string, string>;
      try {
        parsed = JSON.parse(line) as Record<string, string>;
      } catch (error) {
        // Point at the offending line — a bare SyntaxError against a 4k-line
        // export tells the operator nothing about where to look.
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`${path}:${index + 1} is not valid JSON — ${detail}`);
      }
      return {
        email: (parsed.email ?? '').trim().toLowerCase(),
        climbUuid: (parsed.climb_uuid ?? parsed.climbUuid ?? '').trim(),
        eventTs: new Date(parsed.event_ts ?? parsed.timestamp),
      };
    });
  }

  // CSV. PostHog quotes fields containing commas; emails, uuids and ISO
  // timestamps never do, so a split is sufficient for this shape.
  const [header, ...rows] = lines;
  const columns = header.split(',').map((name) => name.trim().replace(/^"|"$/g, ''));
  const emailIndex = columns.indexOf('email');
  const climbIndex = columns.findIndex((name) => name === 'climb_uuid' || name === 'climbUuid');
  const timestampIndex = columns.findIndex((name) => name === 'event_ts' || name === 'timestamp');
  if (emailIndex === -1 || climbIndex === -1 || timestampIndex === -1) {
    throw new Error(`Expected columns email, climb_uuid, event_ts in ${path} — found: ${columns.join(', ')}`);
  }

  return rows.map((row) => {
    const cells = row.split(',').map((cell) => cell.trim().replace(/^"|"$/g, ''));
    return {
      email: (cells[emailIndex] ?? '').toLowerCase(),
      climbUuid: cells[climbIndex] ?? '',
      eventTs: new Date(cells[timestampIndex]),
    };
  });
}

async function revert(snapshotPath: string) {
  const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8')) as Snapshot;
  const { db, close } = createScriptDb();
  try {
    console.log(`Reverting ${snapshot.entries.length} rows from ${snapshotPath} (written ${snapshot.writtenAt})`);
    if (dryRun) {
      console.log('Dry run — nothing written.');
      return;
    }
    // Atomic, same reasoning as the forward pass: a half-reverted logbook is
    // the one state with no clean recovery path.
    const reverted = await db.transaction(async (txn) => {
      let restored = 0;
      for (const entry of snapshot.entries) {
        // Only revert rows still holding the value we wrote, so a later manual
        // correction by the climber is never clobbered.
        const rows = await txn
          .update(boardseshTicks)
          .set({ attemptCount: entry.oldAttemptCount, updatedAt: new Date().toISOString() })
          .where(and(eq(boardseshTicks.uuid, entry.uuid), eq(boardseshTicks.attemptCount, entry.newAttemptCount)))
          .returning({ uuid: boardseshTicks.uuid });
        restored += rows.length;
      }
      return restored;
    });
    console.log(`Reverted ${reverted}/${snapshot.entries.length} rows (skipped rows edited since).`);
  } finally {
    await close();
  }
}

async function main() {
  if (revertPath) return revert(revertPath);

  if (!eventsPath) {
    console.error('Missing --events <file>. See the header of this script for the PostHog query.');
    process.exit(1);
  }

  const events = parseEvents(eventsPath).filter(
    (event) => event.email && event.climbUuid && !Number.isNaN(event.eventTs.getTime()),
  );
  console.log(`Loaded ${events.length} mobile send@2 events from ${eventsPath}`);

  const { db, close } = createScriptDb();
  try {
    // Every candidate row in the window, in one read. Matching happens in
    // memory so the report can distinguish "no row" from "several rows".
    // The upper bound matters as much as the lower one: past the fix, mobile
    // writes legitimate two-try sends again, and an unbounded query would
    // happily rewrite those to 1.
    // A day of slack on the lower bound only — a tick can be backdated slightly
    // relative to the event that logged it. The upper bound gets no slack.
    const windowStart = new Date(Date.parse(since));
    windowStart.setUTCDate(windowStart.getUTCDate() - 1);
    const suspects = await db
      .select({
        uuid: boardseshTicks.uuid,
        userId: boardseshTicks.userId,
        climbUuid: boardseshTicks.climbUuid,
        climbedAt: boardseshTicks.climbedAt,
        attemptCount: boardseshTicks.attemptCount,
        email: users.email,
      })
      .from(boardseshTicks)
      .innerJoin(users, eq(users.id, boardseshTicks.userId))
      .where(
        and(
          eq(boardseshTicks.origin, 'native'),
          eq(boardseshTicks.status, 'send'),
          eq(boardseshTicks.attemptCount, 2),
          gte(boardseshTicks.climbedAt, windowStart.toISOString()),
          lt(boardseshTicks.climbedAt, until),
        ),
      );
    console.log(`Found ${suspects.length} candidate send@2 rows in [${since}, ${until})`);

    const byKey = new Map<string, SuspectRow[]>();
    for (const row of suspects) {
      const key = `${row.email}|${row.climbUuid}`;
      const bucket = byKey.get(key);
      if (bucket) bucket.push(row);
      else byKey.set(key, [row]);
    }

    const toleranceMs = toleranceMinutes * 60_000;
    const claimed = new Set<string>();
    const entries: SnapshotEntry[] = [];
    // Collected during matching, where the row is already in scope — looking
    // each one back up in `suspects` afterwards would be O(entries × suspects).
    const affectedUserIds = new Set<string>();
    let unmatched = 0;
    let ambiguous = 0;

    for (const event of events) {
      const candidates = (byKey.get(`${event.email}|${event.climbUuid}`) ?? []).filter((row) => !claimed.has(row.uuid));
      const withinTolerance = candidates.filter(
        (row) => Math.abs(new Date(row.climbedAt).getTime() - event.eventTs.getTime()) <= toleranceMs,
      );

      if (withinTolerance.length === 0) {
        unmatched += 1;
        continue;
      }
      if (withinTolerance.length > 1) ambiguous += 1;

      // Greedy nearest match, one event to one row. Ambiguity is counted and
      // reported rather than silently resolved.
      const nearest = withinTolerance.reduce((best, row) =>
        Math.abs(new Date(row.climbedAt).getTime() - event.eventTs.getTime()) <
        Math.abs(new Date(best.climbedAt).getTime() - event.eventTs.getTime())
          ? row
          : best,
      );
      claimed.add(nearest.uuid);
      affectedUserIds.add(nearest.userId);
      entries.push({
        uuid: nearest.uuid,
        oldAttemptCount: nearest.attemptCount,
        newAttemptCount: 1,
        climbedAt: new Date(nearest.climbedAt).toISOString(),
      });
    }

    console.log('');
    console.log(`Matched      ${entries.length} rows across ${affectedUserIds.size} users`);
    console.log(`Unmatched    ${unmatched} events (no row within ±${toleranceMinutes}m — backdated or not synced)`);
    console.log(`Ambiguous    ${ambiguous} events had several candidate rows; took the nearest by climbed_at`);
    console.log(`Untouched    ${suspects.length - entries.length} candidate rows (web-written or unmatched)`);
    console.log('');

    if (entries.length === 0) {
      console.log('Nothing to do.');
      return;
    }

    const snapshot: Snapshot = {
      since,
      until,
      toleranceMinutes,
      writtenAt: new Date().toISOString(),
      entries,
    };

    if (dryRun) {
      console.log(`Dry run — would set attempt_count = 1 on ${entries.length} rows. Nothing written.`);
      writeFileSync(outPath, JSON.stringify(snapshot, null, 2));
      console.log(`Planned changes written to ${outPath} (inspect before re-running without --dry-run).`);
      return;
    }

    // Snapshot BEFORE mutating, so an interrupted run is still revertible.
    writeFileSync(outPath, JSON.stringify(snapshot, null, 2));
    console.log(`Snapshot written to ${outPath} — revert with --revert ${outPath}`);

    const uuids = entries.map((entry) => entry.uuid);
    const batchSize = 500;
    // One transaction across every batch. Batching keeps each statement's
    // parameter list sane, but a run interrupted between batches would
    // otherwise leave the logbook half-rewritten — recoverable from the
    // snapshot, but only if the operator still has it. All-or-nothing is
    // cheap at this size and makes the state after a crash unambiguous.
    const updated = await db.transaction(async (txn) => {
      let applied = 0;
      for (let offset = 0; offset < uuids.length; offset += batchSize) {
        const batch = uuids.slice(offset, offset + batchSize);
        const rows = await txn
          .update(boardseshTicks)
          .set({ attemptCount: 1, updatedAt: new Date().toISOString() })
          .where(
            and(
              inArray(boardseshTicks.uuid, batch),
              eq(boardseshTicks.status, 'send'),
              eq(boardseshTicks.attemptCount, 2),
            ),
          )
          .returning({ uuid: boardseshTicks.uuid });
        applied += rows.length;
        console.log(`  ${Math.min(offset + batchSize, uuids.length)}/${uuids.length}`);
      }
      return applied;
    });

    console.log('');
    console.log(`Updated ${updated} rows to 1 try.`);
  } finally {
    await close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
