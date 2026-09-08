import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { isNoMatchClimb } from '@boardsesh/shared-schema';
import { getWorkerDatabaseUrl, setupWorkerDatabase } from './worker-db';

// ---------------------------------------------------------------------------
// Migration 0221 (#5127) replayed against a real Postgres. It promotes a
// no-match declaration APPENDED after the setter's prose into
// board_climbs.characteristics — the form 0135's `LIKE 'no match%'` never saw.
//
// The SQL predicate is the twin of isNoMatchClimb(), so every seed below is
// asserted against BOTH engines: a divergence between them is the failure this
// file exists to catch.
// ---------------------------------------------------------------------------

const drizzleDir = fileURLToPath(new URL('../../../db/drizzle/', import.meta.url));
const MIGRATION_0221 = readFileSync(`${drizzleDir}0221_backfill_trailing_no_match_characteristic.sql`, 'utf8');

/** Descriptions the migration must tag, and the reason each one qualifies. */
const TAGGED = [
  ['trailing after a full stop', 'Kick board is off. No matching.'],
  ['trailing after a newline', 'Remedial training for my terrible open hip climbing\nNo matching'],
  ['trailing after a bracket', 'Nice one (V5) No matching.'],
  ['trailing with no terminal punctuation', '15 degrees. Approx V5. No matching'],
  ['plural', 'Feet follow hands! NO MATCHES'],
  ['leading marker (0135 stray)', 'No match\nCrimpy start'],
  ['leading prose', 'No matching feet allowed'],
] as const;

/** Descriptions the migration must leave alone — the precision contract. */
const UNTAGGED = [
  ['phrase does not open a sentence', 'You can match start hold but the rest is no matching'],
  ['comma separator', 'Campus, no match'],
  ['parenthesised', 'Aidan climb (no matching)'],
  ['unrelated prose', 'Start matched.\nNo feet after the crimp.'],
  ['empty', ''],
] as const;

describe('trailing no-match backfill (0221) — real DB replay', () => {
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle>;

  beforeAll(async () => {
    await setupWorkerDatabase();
    client = postgres(getWorkerDatabaseUrl(), { max: 1, onnotice: () => {} });
    db = drizzle(client);
  });

  afterAll(async () => {
    if (client) await client.end();
  });

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE TABLE board_climbs, users RESTART IDENTITY CASCADE`);
  });

  async function seedClimb(
    uuid: string,
    options: {
      description: string;
      boardType?: string;
      userId?: string | null;
      characteristics?: string[] | null;
    },
  ) {
    const { description, boardType = 'tension', userId = null, characteristics = null } = options;
    if (userId) {
      await db.execute(sql`INSERT INTO users (id, email, name, created_at, updated_at)
        VALUES (${userId}, ${`${userId}@t.com`}, ${userId}, now(), now())`);
    }
    // Bound as a Postgres array literal, not as a JS array: drizzle's `sql`
    // splices an array into a parameter LIST, which renders `()` for `[]` — and
    // `[]` is the explicit-false sentinel this test has to be able to seed.
    const literal = characteristics === null ? null : `{${characteristics.map((token) => `"${token}"`).join(',')}}`;
    await db.execute(sql`INSERT INTO board_climbs
      (uuid, board_type, layout_id, setter_username, name, description, frames, is_listed, user_id, characteristics)
      VALUES (${uuid}, ${boardType}, 11, 's', ${uuid}, ${description}, 'p1r1', true, ${userId},
              ${literal}::text[])`);
  }

  async function apply() {
    await db.execute(sql.raw(MIGRATION_0221));
  }

  async function characteristicsOf(uuid: string): Promise<string[] | null> {
    const rows = await db.execute<{ characteristics: string[] | null }>(
      sql`SELECT characteristics FROM board_climbs WHERE uuid = ${uuid}`,
    );
    return rows[0]?.characteristics ?? null;
  }

  it.each(TAGGED)('tags a %s description', async (_reason, description) => {
    await seedClimb('c1', { description });
    await apply();
    expect(await characteristicsOf('c1')).toEqual(['no_match']);
    // The SQL predicate and isNoMatchClimb must agree on every one of these.
    expect(isNoMatchClimb(description)).toBe(true);
  });

  it.each(UNTAGGED)('leaves a %s description alone', async (_reason, description) => {
    await seedClimb('c1', { description });
    await apply();
    expect(await characteristicsOf('c1')).toBeNull();
    expect(isNoMatchClimb(description)).toBe(false);
  });

  it('never overrides a rule a Boardsesh author saved', async () => {
    // The explicit-false sentinel updateClimb writes when a user turns the
    // toggle off on a climb whose prose still declares no-match.
    await seedClimb('authored-off', {
      description: 'Kick board is off. No matching.',
      userId: 'u1',
      characteristics: [],
    });
    await seedClimb('authored-null', { description: 'Kick board is off. No matching.', userId: 'u2' });
    await apply();
    expect(await characteristicsOf('authored-off')).toEqual([]);
    expect(await characteristicsOf('authored-null')).toBeNull();
  });

  it('fences off the code-driven boards, where the phrase is just user prose', async () => {
    await seedClimb('moon', { description: 'Crimpy. No matching.', boardType: 'moonboard' });
    await seedClimb('woods', { description: 'Crimpy. No matching.', boardType: 'woods' });
    await apply();
    expect(await characteristicsOf('moon')).toBeNull();
    expect(await characteristicsOf('woods')).toBeNull();
  });

  it('appends to an existing array without disturbing the other tokens', async () => {
    await seedClimb('mixed', {
      description: 'Kick board is off. No matching.',
      characteristics: ['no_kickboard'],
    });
    await apply();
    expect(await characteristicsOf('mixed')).toEqual(['no_kickboard', 'no_match']);
  });

  it('is idempotent — a second apply changes nothing', async () => {
    await seedClimb('c1', { description: 'Kick board is off. No matching.' });
    await apply();
    await apply();
    expect(await characteristicsOf('c1')).toEqual(['no_match']);
  });
});
