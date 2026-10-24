import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { eq, sql } from 'drizzle-orm';
import * as schema from '@boardsesh/db/schema';
import type { ConnectionContext } from '@boardsesh/shared-schema';

const { publishSocialEvent } = vi.hoisted(() => ({
  publishSocialEvent: vi.fn(async (_event: { type: string; entityId: string }) => undefined),
}));
vi.mock('../events', () => ({ publishSocialEvent }));
vi.mock('../lib/web-revalidate', () => ({ notifyClimbRevalidated: vi.fn() }));

import { db } from '../db/client';
import { climbMutations } from '../graphql/resolvers/climbs/mutations';
import { resetAllRateLimits } from '../utils/rate-limiter';
import { SaveMoonBoardClimbInputSchema } from '../validation/schemas';

// ---------------------------------------------------------------------------
// The deprecated climb audience (real Postgres).
//
// A climb has no audience, but installed builds still send `privacy` on a
// publish, and a publish queued offline before the update carries the choice
// the climber made then. "Only me" or "Followers" saves the climb as a draft
// (owner-only, the nearest thing that still exists) instead of silently
// publishing it to everyone. "Public" publishes. No climb policy is written.
// ---------------------------------------------------------------------------

const describeWithDatabase = process.env.SKIP_TEST_INFRA === '1' ? describe.skip : describe;

const SETTER = 'deprecated-audience-setter';
const LAYOUT_ID = 99_785;
const ctx = { userId: SETTER, isAuthenticated: true, connectionId: 'deprecated-audience' } as ConnectionContext;

async function removeFixtures(): Promise<void> {
  await db.execute(sql`DELETE FROM content_privacy WHERE owner_id = ${SETTER}`);
  await db.execute(sql`DELETE FROM board_climb_stats WHERE climb_uuid IN (
    SELECT uuid FROM board_climbs WHERE user_id = ${SETTER})`);
  await db.execute(sql`DELETE FROM board_climbs WHERE user_id = ${SETTER}`);
  await db.execute(sql`DELETE FROM users WHERE id = ${SETTER}`);
}

function publish(audience: string | null, name: string) {
  return climbMutations.saveClimb(
    {},
    {
      input: {
        boardType: 'kilter',
        layoutId: LAYOUT_ID,
        name,
        description: '',
        isDraft: false,
        frames: audience === 'public' ? 'p2r12' : audience === null ? 'p3r12' : 'p1r12',
        angle: 40,
        ...(audience ? { privacy: { audience, privacyRevision: 1 } } : {}),
      },
    },
    ctx,
  );
}

async function stored(uuid: string) {
  const [climb] = await db
    .select({ isDraft: schema.boardClimbs.isDraft, isListed: schema.boardClimbs.isListed })
    .from(schema.boardClimbs)
    .where(eq(schema.boardClimbs.uuid, uuid));
  const policies = await db
    .select({ entityId: schema.contentPrivacy.entityId })
    .from(schema.contentPrivacy)
    .where(eq(schema.contentPrivacy.entityId, uuid));
  const announced = publishSocialEvent.mock.calls.some(
    ([event]) => event.type === 'climb.created' && event.entityId === uuid,
  );
  return { ...climb, policies: policies.length, announced };
}

describeWithDatabase('the deprecated climb audience (real DB)', () => {
  beforeAll(async () => {
    await removeFixtures();
    await db.insert(schema.users).values({ id: SETTER, name: 'Setter', email: `${SETTER}@example.test` });
  });
  afterAll(removeFixtures);
  beforeEach(() => {
    resetAllRateLimits();
    publishSocialEvent.mockClear();
  });

  it.each(['only_me', 'followers'])('saves a publish asking for %s as a draft, unannounced', async (audience) => {
    const saved = await publish(audience, `Restricted ${audience}`);
    expect(saved.publishedAt).toBeNull();
    expect(await stored(saved.uuid)).toEqual({ isDraft: true, isListed: false, policies: 0, announced: false });
  });

  it.each([['public'], [null]])('publishes when the audience is %s', async (audience) => {
    const saved = await publish(audience, `Open ${audience}`);
    expect(saved.publishedAt).not.toBeNull();
    expect(await stored(saved.uuid)).toEqual({ isDraft: false, isListed: true, policies: 0, announced: true });
  });

  it('keeps a draft a draft when an edit publishes it with a restricted audience', async () => {
    const draft = await climbMutations.saveClimb(
      {},
      {
        input: {
          boardType: 'kilter',
          layoutId: LAYOUT_ID,
          name: 'Draft to publish',
          description: '',
          isDraft: true,
          frames: 'p1r12',
          angle: 40,
        },
      },
      ctx,
    );
    await climbMutations.updateClimb(
      {},
      {
        input: {
          uuid: draft.uuid,
          boardType: 'kilter',
          isDraft: false,
          privacy: { audience: 'only_me', privacyRevision: 1 },
        },
      },
      ctx,
    );
    expect(await stored(draft.uuid)).toEqual({ isDraft: true, isListed: false, policies: 0, announced: false });
  });

  it('rejects a climb policy row: the CHECK no longer allows climb (0281)', async () => {
    await expect(
      db.execute(
        sql`INSERT INTO content_privacy (entity_type, entity_id, owner_id, audience)
          VALUES ('climb', 'no-such-climb', ${SETTER}, 'only_me')`,
      ),
    ).rejects.toMatchObject({ cause: { message: expect.stringContaining('content_privacy_type_check') } });
  });

  it('parses a MoonBoard publish with a restricted audience as a draft', () => {
    const parsed = SaveMoonBoardClimbInputSchema.parse({
      boardType: 'moonboard',
      layoutId: 1,
      name: 'MoonBoard restricted',
      holds: { start: ['A1'], hand: [], finish: ['K18'] },
      angle: 40,
      isDraft: false,
      privacy: { audience: 'followers', privacyRevision: 1 },
    });
    expect(parsed.isDraft).toBe(true);
    expect(parsed).not.toHaveProperty('privacy');
  });
});
