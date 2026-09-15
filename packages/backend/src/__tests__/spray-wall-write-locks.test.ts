import { describe, expect, it } from 'vite-plus/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Every writer of spray wall state takes the wall lock, and takes it FIRST.
 *
 * Editing a draft's holds, publishing, discarding, deleting the wall and writing a
 * climb against it all race each other: each reads some piece of the wall's state
 * (is this version still a draft? which generation is published? does the wall have
 * a published version at all?) and then writes on the strength of that read. Without
 * `pg_advisory_xact_lock(wall_id)` held across both, a publish landing in the window
 * turns an edit into a silent mutation of a PUBLISHED generation — moving every
 * climb set on it — or lets an angle change through on a wall that has just been
 * published.
 *
 * This is a SOURCE-level test on purpose. The behaviour it protects is a race, so a
 * behavioural test would have to interleave two transactions and would be flaky
 * about it; and the failure mode is someone adding a twelfth writer, or reordering
 * an existing one so a read happens before the lock. Reading the file catches both,
 * deterministically, at the moment the code is written.
 *
 * If you are here because this test failed: you added or moved a write to one of the
 * spray-owned tables. Put `await lockWallForWrite(tx, <wallId>)` at the top of that
 * transaction, and re-read anything you decided on before it.
 */

const SPRAY_WALLS_SOURCE = readFileSync(
  fileURLToPath(new URL('../graphql/resolvers/board/spray-walls.ts', import.meta.url)),
  'utf8',
);
const SPRAY_AUTHORING_SOURCE = readFileSync(
  fileURLToPath(new URL('../graphql/resolvers/climbs/spray-authoring.ts', import.meta.url)),
  'utf8',
);

/**
 * The tables whose rows ARE the wall's mutable state.
 *
 * `boardHoles` / `boardPlacements` are in the list because a hold's catalogue pair
 * is written and deleted alongside its `spray_wall_holds` row — a writer that
 * allocated catalogue ids outside the lock could hand the same id to two drafts.
 */
const GUARDED_TABLES = ['sprayWallVersions', 'sprayWallHolds', 'boardHoles', 'boardPlacements', 'sprayWalls'];

const WRITE_PATTERN = new RegExp(String.raw`\.(insert|update|delete)\(dbSchema\.(${GUARDED_TABLES.join('|')})\)`);

/** Raw SQL that writes the same state without going through drizzle. */
const RAW_WRITE_PATTERN = /DELETE FROM feed_items|UPDATE board_climbs/;

/**
 * The body of a named function or resolver property, by brace matching from its
 * opening `{`. Crude on purpose — a real parser would be a dependency for one test,
 * and the shapes here are all `name: async (...) => {` or `async function name(...) {`.
 */
function functionBody(source: string, name: string): string {
  const declaration = new RegExp(
    String.raw`(?:^|\n)\s*(?:export\s+)?(?:async\s+function\s+${name}\b|${name}:\s*async)`,
  );
  const match = declaration.exec(source);
  if (!match) throw new Error(`could not find ${name} — did it get renamed?`);

  // Skip the PARAMETER list before looking for the body: these signatures
  // destructure (`{ input }: { input: unknown }`), so the first `{` after the name
  // is a parameter, not the body. Balance the parens first, then take the next `{`.
  let cursor = source.indexOf('(', match.index + match[0].length);
  if (cursor === -1) throw new Error(`could not find the parameters of ${name}`);
  let parens = 0;
  for (; cursor < source.length; cursor++) {
    if (source[cursor] === '(') parens++;
    else if (source[cursor] === ')') {
      parens--;
      if (parens === 0) break;
    }
  }
  const open = source.indexOf('{', cursor);
  if (open === -1) throw new Error(`could not find the body of ${name}`);

  let depth = 0;
  for (let index = open; index < source.length; index++) {
    if (source[index] === '{') depth++;
    else if (source[index] === '}') {
      depth--;
      if (depth === 0) return source.slice(open, index + 1);
    }
  }
  throw new Error(`unbalanced braces reading ${name}`);
}

/** Offset of the first guarded write in a body, or -1. */
function firstWriteOffset(body: string): number {
  const drizzle = body.search(WRITE_PATTERN);
  const raw = body.search(RAW_WRITE_PATTERN);
  if (drizzle === -1) return raw;
  if (raw === -1) return drizzle;
  return Math.min(drizzle, raw);
}

/**
 * Every writer, named explicitly rather than discovered.
 *
 * A discovered list would quietly shrink if a function were renamed — the test would
 * keep passing while covering less. Naming them means a rename fails loudly, and the
 * list doubles as the answer to "what can change a wall?".
 */
const WRITERS: Array<{ name: string; source: string; why: string; exempt?: string }> = [
  {
    name: 'createSprayWall',
    source: SPRAY_WALLS_SOURCE,
    why: 'it inserts the spray_walls row itself',
    // The one writer that legitimately holds no lock: it CREATES the wall, so
    // there is no wall id to lock on until the insert has happened, and nothing
    // else can be touching a wall that does not exist yet. The id comes from a
    // sequence, so two concurrent creates cannot collide either.
    exempt: 'the wall does not exist yet, so there is nothing to lock on',
  },
  { name: 'createSprayWallVersion', source: SPRAY_WALLS_SOURCE, why: 'the one-draft check decides on a read' },
  { name: 'upsertSprayWallHolds', source: SPRAY_WALLS_SOURCE, why: 'the draft-status and alive-set reads decide' },
  { name: 'removeSprayWallHolds', source: SPRAY_WALLS_SOURCE, why: 'the draft-status and alive-set reads decide' },
  { name: 'publishSprayWallVersion', source: SPRAY_WALLS_SOURCE, why: 'supersede keys on current_version_id' },
  {
    name: 'publishDraftUnderLock',
    source: SPRAY_WALLS_SOURCE,
    why: 'it IS the publish: supersede, hold count, catalogue image and the integrity recompute',
  },
  { name: 'commitSprayWallVersion', source: SPRAY_WALLS_SOURCE, why: 'the alive-set and draft-status reads decide' },
  { name: 'discardSprayWallVersion', source: SPRAY_WALLS_SOURCE, why: 'the draft-status read decides' },
  { name: 'updateSprayWall', source: SPRAY_WALLS_SOURCE, why: 'the angle rule reads current_version_id' },
  { name: 'deleteSprayWall', source: SPRAY_WALLS_SOURCE, why: 'a publish must not land on a wall being deleted' },
  {
    name: 'assertSprayHoldsAreAlive',
    source: SPRAY_AUTHORING_SOURCE,
    why: 'the saveClimb / updateClimb spray branch validates against the published generation',
  },
];

describe('every spray wall writer holds the wall lock', () => {
  it.each(WRITERS)('$name takes it, because $why', ({ name, source, exempt }) => {
    const body = functionBody(source, name);
    const lockAt = body.indexOf('lockWallForWrite(');

    if (exempt) {
      // Pinned as an exemption rather than simply omitted, so removing the reason
      // means removing the entry — and the coverage test below then fails.
      expect(lockAt, `${name} is listed exempt (${exempt}) but now locks — drop the exemption`).toBe(-1);
      return;
    }

    expect(lockAt, `${name} never calls lockWallForWrite`).toBeGreaterThanOrEqual(0);

    // …and INSIDE the transaction, not in front of it. `pg_advisory_xact_lock` is
    // transaction-scoped: called on the pool it takes a lock on a throwaway
    // connection, which commits and releases before the transaction that needed it
    // has even opened. That reads exactly like a correct writer — the call is
    // there, and it is before the first write — while serialising nothing. The
    // helpers are exempt: they take an executor and are called from inside their
    // caller's transaction, so `db.transaction(` never appears in their bodies.
    const transactionAt = body.indexOf('db.transaction(');
    if (transactionAt !== -1) {
      expect(
        lockAt,
        `${name} locks at ${lockAt}, outside the transaction that opens at ${transactionAt}`,
      ).toBeGreaterThan(transactionAt);
    }

    const writeAt = firstWriteOffset(body);
    if (writeAt === -1) {
      // Two shapes have no guarded write of their own and still have to lock.
      //
      // `assertSprayHoldsAreAlive` only READS — but it reads to authorize a write
      // its caller is about to make in the same transaction, so the lock still has
      // to be held from here on.
      //
      // `publishSprayWallVersion` delegates every write to `publishDraftUnderLock`,
      // which is itself in this list and takes the lock again (re-entrant within a
      // transaction) before its first write. The resolver still locks, so a reader
      // of either function sees the rule stated where the transaction opens.
      expect(['assertSprayHoldsAreAlive', 'publishSprayWallVersion']).toContain(name);
      return;
    }
    expect(lockAt, `${name} writes at offset ${writeAt} before locking at ${lockAt}`).toBeLessThan(writeAt);
  });

  it('covers every writer in the file, so a new one cannot slip in unlisted', () => {
    // The named list above is the contract; this catches a TWELFTH writer being
    // added without being added to it.
    const resolverNames = [...SPRAY_WALLS_SOURCE.matchAll(/\n {2}(\w+): async \(/g)].map((match) => match[1]);
    const writersInFile = resolverNames.filter(
      (name) => firstWriteOffset(functionBody(SPRAY_WALLS_SOURCE, name)) !== -1,
    );
    const listed = new Set(WRITERS.map((writer) => writer.name));
    expect(writersInFile.filter((name) => !listed.has(name))).toEqual([]);
  });

  it('locks on the wall id, not the version id', () => {
    // A per-version lock would not make an edit and a publish queue: they contend on
    // different rows (a version row and the wall's `current_version_id`).
    const body = functionBody(SPRAY_WALLS_SOURCE, 'lockWallForWrite');
    expect(body).toMatch(/pg_advisory_xact_lock\(\$\{SPRAY_WALL_LOCK_NAMESPACE\}, \$\{wallId\}\)/);
  });
});

/**
 * The lock and the re-resolve, in that order, inside `assertSprayHoldsAreAlive`.
 *
 * The bug this pins: `SprayClimbTarget.publishedVersionNumber` is resolved BEFORE
 * the write transaction opens, so validating against it would mean validating
 * against a generation `publishSprayWallVersion` may have replaced since. The fix
 * is to take the lock and read the published generation again under it — and the
 * order matters, because a re-resolve before the lock is the same bug with more
 * steps.
 *
 * Asserted through a recording executor rather than a spy: the ORDER of the calls
 * the function actually makes to its database handle is the observable behaviour,
 * and a spy on a module-private helper would break the moment it is renamed.
 */
describe('assertSprayHoldsAreAlive re-resolves the published generation under the lock', () => {
  type Recorded = { kind: 'lock' | 'select'; detail: string };

  function recordingExecutor(publishedVersion: number, aliveHoldIds: number[]) {
    const calls: Recorded[] = [];
    let selectCount = 0;

    const resolveTo = (rows: unknown[]) => {
      const chain: Record<string, unknown> = {};
      for (const method of ['from', 'innerJoin', 'leftJoin', 'where', 'limit', 'orderBy']) {
        chain[method] = () => chain;
      }
      chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve(rows).then(resolve);
      return chain;
    };

    const executor = {
      execute: (query: unknown) => {
        // `lockWallForWrite` is the only `execute` on this path.
        calls.push({ kind: 'lock', detail: JSON.stringify(query).includes('advisory') ? 'advisory' : 'other' });
        return Promise.resolve([]);
      },
      select: () => {
        selectCount += 1;
        if (selectCount === 1) {
          calls.push({ kind: 'select', detail: 'publishedVersion' });
          return resolveTo([{ versionNumber: publishedVersion }]);
        }
        calls.push({ kind: 'select', detail: 'aliveHolds' });
        return resolveTo(aliveHoldIds.map((holdId) => ({ holdId })));
      },
    };

    return { calls, executor: executor as never };
  }

  it('locks first, then reads the published version, then the alive holds', async () => {
    const { calls, executor } = recordingExecutor(7, [11, 12]);
    const { assertSprayHoldsAreAlive } = await import('../graphql/resolvers/climbs/spray-authoring');

    await assertSprayHoldsAreAlive(executor, { wallId: 42, publishedVersionNumber: 1 }, [11]);

    expect(calls.map((call) => call.detail)).toEqual(['advisory', 'publishedVersion', 'aliveHolds']);
  });

  it('validates against the RE-RESOLVED generation, not the one on the target', async () => {
    // The target says version 1; the wall now says 7, and hold 11 is not alive at 7.
    // A function that trusted the target would accept the climb.
    const { executor } = recordingExecutor(7, [99]);
    const { assertSprayHoldsAreAlive } = await import('../graphql/resolvers/climbs/spray-authoring');

    await expect(assertSprayHoldsAreAlive(executor, { wallId: 42, publishedVersionNumber: 1 }, [11])).rejects.toThrow(
      /Hold 11 is not on this wall/i,
    );
  });

  it('does not touch the database at all when there are no holds to check', async () => {
    // The early return is ahead of the lock, so a metadata-only edit of a non-spray
    // climb cannot end up queueing behind somebody's reset.
    const { calls, executor } = recordingExecutor(7, []);
    const { assertSprayHoldsAreAlive } = await import('../graphql/resolvers/climbs/spray-authoring');

    await assertSprayHoldsAreAlive(executor, { wallId: 42, publishedVersionNumber: 7 }, []);
    expect(calls).toEqual([]);
  });
});

/**
 * The feed decision is made under the lock, not carried in from before it.
 *
 * `SprayClimbTarget.publishesFeedEvents` is resolved before the write transaction
 * and the event is emitted after it commits. A concurrent `updateSprayWall` going
 * private in that window runs its `feed_items` purge BEFORE the emit, so a decision
 * based on the stale value writes a fresh row the purge has already been past.
 *
 * Pinned at source as well as behaviourally, because the race is a window of a few
 * milliseconds: a DB-level interleave test would be flaky about hitting it, while
 * "the resolver reads this under the lock" is exactly the property that fixes it.
 */
/**
 * The same race from the other side: `updateSprayWall` deciding whether the wall is
 * LOSING public status. Read before the transaction, that value is false for a wall
 * a concurrent update has just made public, so the `feed_items` purge is skipped and
 * the announcement made in that window outlives the wall's privacy.
 */
describe('the feed retraction decision is re-read under the wall lock', () => {
  it('updateSprayWall reads is_public after the lock, not before', () => {
    const body = functionBody(SPRAY_WALLS_SOURCE, 'updateSprayWall');

    const lockAt = body.indexOf('lockWallForWrite(');
    const decisionAt = body.indexOf('const losingPublic =');
    expect(lockAt).toBeGreaterThanOrEqual(0);
    expect(decisionAt, 'updateSprayWall no longer computes losingPublic').toBeGreaterThanOrEqual(0);
    expect(decisionAt, 'losingPublic is decided before the wall lock is held').toBeGreaterThan(lockAt);

    // …and from a fresh read, never from the wall loaded for the authz check.
    expect(body.slice(decisionAt, decisionAt + 200)).not.toMatch(/board\.isPublic/);
    expect(body.slice(0, decisionAt)).toMatch(/\.select\(\{\s*isPublic:/);
  });
});

describe('the climb.created decision is re-read under the wall lock', () => {
  const MUTATIONS_SOURCE = readFileSync(
    fileURLToPath(new URL('../graphql/resolvers/climbs/mutations.ts', import.meta.url)),
    'utf8',
  );

  it.each(['saveClimb', 'updateClimb'])('%s decides from the locked read', (resolver) => {
    const body = functionBody(MUTATIONS_SOURCE, resolver);

    const lockedReadAt = body.indexOf('sprayWallMayAnnounceUnderLock(');
    expect(lockedReadAt, `${resolver} never re-reads visibility under the lock`).toBeGreaterThanOrEqual(0);

    // And the emit must consult the variable that read fills, never the value
    // carried in on the target.
    const emitAt = body.indexOf("type: 'climb.created'");
    expect(emitAt).toBeGreaterThan(lockedReadAt);
    expect(
      body.slice(0, emitAt),
      `${resolver} still gates the event on the pre-transaction sprayTarget.publishesFeedEvents`,
    ).not.toMatch(/(?:mayAnnounce|transitioningToPublished)[^\n]*sprayTarget\.publishesFeedEvents/);
  });

  it('reads visibility only after taking the lock', async () => {
    const calls: string[] = [];
    const chain: Record<string, unknown> = {};
    for (const method of ['from', 'innerJoin', 'where', 'limit']) chain[method] = () => chain;
    chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve([{ isPublic: false }]).then(resolve);

    const executor = {
      execute: () => {
        calls.push('lock');
        return Promise.resolve([]);
      },
      select: () => {
        calls.push('read');
        return chain;
      },
    } as never;

    const { sprayWallMayAnnounceUnderLock } = await import('../graphql/resolvers/climbs/spray-authoring');
    await expect(sprayWallMayAnnounceUnderLock(executor, 42)).resolves.toBe(false);
    expect(calls).toEqual(['lock', 'read']);
  });
});
