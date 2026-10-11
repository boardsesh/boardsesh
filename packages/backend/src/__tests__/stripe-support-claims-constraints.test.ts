import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { eq, sql } from 'drizzle-orm';
import * as schema from '@boardsesh/db/schema';
import { db } from '../db/client';
import { getPostgresConstraintName, getPostgresErrorCode } from '../utils/postgres-errors';

const USER_ID = 'stripe-claims-constraints-user';

beforeEach(async () => {
  await db.delete(schema.users).where(eq(schema.users.id, USER_ID));
  await db.insert(schema.users).values({ id: USER_ID, email: 'stripe-claims-constraints@test.com' });
});

async function expectConstraintViolation(insertPromise: Promise<unknown>, code: string, constraint: string) {
  let caughtError: unknown;
  try {
    await insertPromise;
  } catch (error) {
    caughtError = error;
  }
  expect(caughtError).toBeDefined();
  expect(getPostgresErrorCode(caughtError)).toBe(code);
  expect(getPostgresConstraintName(caughtError)).toBe(constraint);
}

describe('Stripe support claim constraints — real PostgreSQL', () => {
  it.each(['MONTHLY', 'ONE_TIME', 'unknown'])('rejects unsupported cadence %s', async (cadence) => {
    // Parameterized SQL deliberately bypasses the TypeScript union to test the database guard.
    await expectConstraintViolation(
      db
        .insert(schema.stripeSupportClaims)
        .values({ id: 'invalid-cadence', userId: USER_ID, cadence: sql`${cadence}` }),
      '23514',
      'stripe_support_claims_cadence_check',
    );
  });

  it('rejects a second monthly claim for the same account', async () => {
    await db.insert(schema.stripeSupportClaims).values({ id: 'monthly-first', userId: USER_ID, cadence: 'monthly' });
    await expectConstraintViolation(
      db.insert(schema.stripeSupportClaims).values({ id: 'monthly-second', userId: USER_ID, cadence: 'monthly' }),
      '23505',
      'stripe_support_claims_monthly_unique',
    );
  });

  it('allows multiple one-time claims and unassigned checkout session IDs beside a monthly claim', async () => {
    await db.insert(schema.stripeSupportClaims).values([
      { id: 'monthly', userId: USER_ID, cadence: 'monthly', checkoutSessionId: null },
      { id: 'one-time-first', userId: USER_ID, cadence: 'one_time', checkoutSessionId: null },
      { id: 'one-time-second', userId: USER_ID, cadence: 'one_time', checkoutSessionId: null },
    ]);
    const claims = await db
      .select()
      .from(schema.stripeSupportClaims)
      .where(eq(schema.stripeSupportClaims.userId, USER_ID));
    expect(claims).toHaveLength(3);
    expect(claims.every((claim) => claim.checkoutSessionId === null)).toBe(true);
  });

  it('rejects a reused non-null checkout session ID', async () => {
    await db.insert(schema.stripeSupportClaims).values({
      id: 'checkout-first',
      userId: USER_ID,
      cadence: 'one_time',
      checkoutSessionId: 'cs_constraint_unique',
    });
    await expectConstraintViolation(
      db.insert(schema.stripeSupportClaims).values({
        id: 'checkout-second',
        userId: USER_ID,
        cadence: 'one_time',
        checkoutSessionId: 'cs_constraint_unique',
      }),
      '23505',
      'stripe_support_claims_checkout_unique',
    );
  });
});
