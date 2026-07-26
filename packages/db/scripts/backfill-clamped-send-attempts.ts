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
 *   --since <date>      Lower bound on climbed_at (default 2026-05-24).
 *   --out <file>        Snapshot path (default ./clamped-send-attempts-<since>.json).
 *
 * Safe to re-run: rows already at 1 try simply stop matching.
 */

import { readFileSync, writeFileSync } from 'fs';
import { sql } from 'drizzle-orm';
import { createScriptDb } from './db-connection.js';
import { executeRows } from '../src/client/index.js';

const CLAMP_LANDED = '2026-05-24';

const args = process.argv.slice(2);
function flag(name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

const eventsPath = flag('--events');
const revertPath = flag('--revert');
const dryRun = args.includes('--dry-run');
const toleranceMinutes = Number(flag('--tolerance-min') ?? 60);
const since = flag('--since') ?? CLAMP_LANDED;
const outPath = flag('--out') ?? `./clamped-send-attempts-${since}.json`;

type TickEvent = { email: string; climbUuid: string; eventTs: Date };
type SuspectRow = { uuid: string; userId: string; climbUuid: string; climbedAt: string; attemptCount: number };
type SnapshotEntry = { uuid: string; oldAttemptCount: number; newAttemptCount: number; climbedAt: string };
type Snapshot = { since: string; toleranceMinutes: number; writtenAt: string; entries: SnapshotEntry[] };

/** Parses the PostHog export. Accepts JSONL or CSV with a header row. */
function parseEvents(path: string): TickEvent[] {
  const raw = readFileSync(path, 'utf8').trim();
  if (!raw) return [];

  const lines = raw.split('\n').filter((line) => line.trim().length > 0);
  const isJsonl = lines[0].trimStart().startsWith('{');

  if (isJsonl) {
    return lines.map((line) => {
      const parsed = JSON.parse(line) as Record<string, string>;
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
    let reverted = 0;
    for (const entry of snapshot.entries) {
      // Only revert rows still holding the value we wrote, so a later manual
      // correction by the climber is never clobbered.
      const rows = await executeRows<{ uuid: string }>(
        db,
        sql`UPDATE boardsesh_ticks
            SET attempt_count = ${entry.oldAttemptCount}, updated_at = NOW()
            WHERE uuid = ${entry.uuid} AND attempt_count = ${entry.newAttemptCount}
            RETURNING uuid`,
      );
      reverted += rows.length;
    }
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
    const suspects = await executeRows<SuspectRow & { email: string }>(
      db,
      sql`SELECT t.uuid,
                 t.user_id      AS "userId",
                 t.climb_uuid   AS "climbUuid",
                 t.climbed_at   AS "climbedAt",
                 t.attempt_count AS "attemptCount",
                 lower(u.email) AS email
          FROM boardsesh_ticks t
          JOIN users u ON u.id = t.user_id
          WHERE t.origin = 'native'
            AND t.status = 'send'
            AND t.attempt_count = 2
            AND t.climbed_at >= ${since}::timestamp - INTERVAL '1 day'`,
    );
    console.log(`Found ${suspects.length} candidate send@2 rows since ${since}`);

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
    let updated = 0;
    const batchSize = 500;
    for (let offset = 0; offset < uuids.length; offset += batchSize) {
      const batch = uuids.slice(offset, offset + batchSize);
      const rows = await executeRows<{ uuid: string }>(
        db,
        sql`UPDATE boardsesh_ticks
            SET attempt_count = 1, updated_at = NOW()
            WHERE uuid = ANY(${batch}::text[])
              AND status = 'send'
              AND attempt_count = 2
            RETURNING uuid`,
      );
      updated += rows.length;
      console.log(`  ${Math.min(offset + batchSize, uuids.length)}/${uuids.length}`);
    }

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
