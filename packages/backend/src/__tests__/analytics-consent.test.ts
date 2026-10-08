import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import type { AnalyticsConsent, ConnectionContext, SetAnalyticsConsentInput } from '@boardsesh/shared-schema';
import * as dbSchema from '@boardsesh/db/schema';
import { db } from '../db/client';
import {
  analyticsConsentMutations,
  analyticsConsentQueries,
  grantIsStale,
} from '../graphql/resolvers/users/analytics-consent';
import { resetAllRateLimits } from '../utils/rate-limiter';

/**
 * Real-DB coverage for the account copy of analytics consent (#2644).
 *
 * The rule under test: a denial is always written, and a grant is dropped when
 * the account already holds an answer the client never saw. That is what stops
 * a device that last synced before "No thanks" on another device from turning
 * tracking back on.
 */

let connectionCounter = 0;
const authCtx = (userId: string): ConnectionContext =>
  ({ connectionId: `consent-${userId}-${connectionCounter++}`, isAuthenticated: true, userId }) as ConnectionContext;
const anonCtx = (): ConnectionContext =>
  ({ connectionId: `consent-anon-${connectionCounter++}`, isAuthenticated: false }) as ConnectionContext;

async function createUser(): Promise<string> {
  const userId = randomUUID();
  await db.insert(dbSchema.users).values({ id: userId, email: `${userId}@example.invalid` });
  return userId;
}

function setConsent(userId: string, input: SetAnalyticsConsentInput): Promise<AnalyticsConsent> {
  return analyticsConsentMutations.setAnalyticsConsent(null, { input }, authCtx(userId));
}

function readConsent(userId: string): Promise<AnalyticsConsent | null> {
  return analyticsConsentQueries.myAnalyticsConsent(null, {}, authCtx(userId));
}

async function storedRows(userId: string) {
  return db
    .select()
    .from(dbSchema.userAnalyticsConsentEvents)
    .where(eq(dbSchema.userAnalyticsConsentEvents.userId, userId))
    .orderBy(asc(dbSchema.userAnalyticsConsentEvents.id));
}

const grantFromPhone = (basedOnDecidedAt: string | null): SetAnalyticsConsentInput => ({
  analytics: 'granted',
  version: 1,
  source: 'ios',
  basedOnDecidedAt,
});
const denyFromWeb = (basedOnDecidedAt: string | null = null): SetAnalyticsConsentInput => ({
  analytics: 'denied',
  version: 1,
  source: 'web',
  basedOnDecidedAt,
});

beforeEach(() => {
  resetAllRateLimits();
});

describe('analytics consent authentication', () => {
  it('refuses the query without a signed-in climber', async () => {
    await expect(analyticsConsentQueries.myAnalyticsConsent(null, {}, anonCtx())).rejects.toThrow(
      'Authentication required',
    );
  });

  it('refuses the mutation without a signed-in climber and writes nothing', async () => {
    const before = await db.select().from(dbSchema.userAnalyticsConsentEvents);
    await expect(
      analyticsConsentMutations.setAnalyticsConsent(null, { input: denyFromWeb() }, anonCtx()),
    ).rejects.toThrow('Authentication required');
    const after = await db.select().from(dbSchema.userAnalyticsConsentEvents);
    expect(after).toHaveLength(before.length);
  });
});

describe('myAnalyticsConsent', () => {
  it('is null for a climber who never answered', async () => {
    const userId = await createUser();
    expect(await readConsent(userId)).toBeNull();
  });

  it('returns the newest answer', async () => {
    const userId = await createUser();
    const first = await setConsent(userId, grantFromPhone(null));
    const second = await setConsent(userId, denyFromWeb(first.decidedAt));
    expect(await readConsent(userId)).toEqual(second);
  });
});

describe('setAnalyticsConsent', () => {
  it('writes a first grant and stamps the server clock', async () => {
    const userId = await createUser();
    const before = Date.now();
    const result = await setConsent(userId, grantFromPhone(null));
    const after = Date.now();

    expect(result).toMatchObject({ analytics: 'granted', version: 1, source: 'ios' });
    // Server time, not anything the client sent: the input carried no time.
    const decidedAtMs = Date.parse(result.decidedAt);
    expect(decidedAtMs).toBeGreaterThanOrEqual(before - 1_000);
    expect(decidedAtMs).toBeLessThanOrEqual(after + 1_000);
    expect(await storedRows(userId)).toHaveLength(1);
  });

  it('drops a stale grant: the account denial the phone never saw wins', async () => {
    const userId = await createUser();
    // Phone grants, then the climber says "No thanks" on the web.
    const phoneGrant = await setConsent(userId, grantFromPhone(null));
    const webDenial = await setConsent(userId, denyFromWeb(phoneGrant.decidedAt));

    // The phone, still believing its own grant is current, pushes it again.
    const result = await setConsent(userId, grantFromPhone(phoneGrant.decidedAt));

    expect(result).toEqual(webDenial);
    expect(await storedRows(userId)).toHaveLength(2);
    expect((await readConsent(userId))?.analytics).toBe('denied');
  });

  it('drops a grant that claims to have seen nothing while the account holds a denial', async () => {
    const userId = await createUser();
    const webDenial = await setConsent(userId, denyFromWeb());

    const result = await setConsent(userId, grantFromPhone(null));

    expect(result).toEqual(webDenial);
    expect(await storedRows(userId)).toHaveLength(1);
  });

  it('writes a grant made after seeing the current answer, so a climber can change their mind', async () => {
    const userId = await createUser();
    const webDenial = await setConsent(userId, denyFromWeb());

    const result = await setConsent(userId, grantFromPhone(webDenial.decidedAt));

    expect(result.analytics).toBe('granted');
    expect(Date.parse(result.decidedAt)).toBeGreaterThanOrEqual(Date.parse(webDenial.decidedAt));
    expect(await storedRows(userId)).toHaveLength(2);
    expect((await readConsent(userId))?.analytics).toBe('granted');
  });

  it('writes a repeat grant from a device that saw none, as a record of that device agreeing', async () => {
    const userId = await createUser();
    await setConsent(userId, { ...grantFromPhone(null), source: 'web' });

    const result = await setConsent(userId, grantFromPhone(null));

    expect(result).toMatchObject({ analytics: 'granted', source: 'ios' });
    expect(await storedRows(userId)).toHaveLength(2);
  });

  it('always writes a denial, even one based on an old answer', async () => {
    const userId = await createUser();
    const firstGrant = await setConsent(userId, grantFromPhone(null));
    await setConsent(userId, grantFromPhone(firstGrant.decidedAt));

    const result = await setConsent(userId, denyFromWeb('2000-01-01T00:00:00.000Z'));

    expect(result.analytics).toBe('denied');
    expect(await storedRows(userId)).toHaveLength(3);
    expect((await readConsent(userId))?.analytics).toBe('denied');
  });

  it('never loses a denial to a grant racing it', async () => {
    // Without the per-user lock both writes can read "no answer yet" and the
    // grant can land last. With it, either the grant goes first (then the
    // denial lands on top) or the denial goes first (then the grant, based on
    // nothing, is dropped). Both end denied.
    for (let round = 0; round < 5; round++) {
      const userId = await createUser();
      await Promise.all([setConsent(userId, grantFromPhone(null)), setConsent(userId, denyFromWeb())]);
      expect((await readConsent(userId))?.analytics).toBe('denied');
    }
  });

  it.each([
    ['an unknown choice', { analytics: 'maybe', version: 1, source: 'web' }],
    ['an unknown source', { analytics: 'granted', version: 1, source: 'desktop' }],
    ['a zero version', { analytics: 'granted', version: 0, source: 'web' }],
    ['a fractional version', { analytics: 'granted', version: 1.5, source: 'web' }],
    ['a non-date basedOnDecidedAt', { analytics: 'granted', version: 1, source: 'web', basedOnDecidedAt: 'later' }],
  ])('rejects %s and writes nothing', async (_label, input) => {
    const userId = await createUser();
    await expect(
      analyticsConsentMutations.setAnalyticsConsent(
        null,
        { input: input as unknown as SetAnalyticsConsentInput },
        authCtx(userId),
      ),
    ).rejects.toThrow('Invalid input');
    expect(await storedRows(userId)).toHaveLength(0);
  });
});

describe('grantIsStale', () => {
  const denial = { analytics: 'denied', version: 1, source: 'web', decidedAt: new Date('2026-10-02T08:00:00.123Z') };
  const grant = { ...denial, analytics: 'granted' };

  it('is never stale against an empty account', () => {
    expect(grantIsStale(null, null)).toBe(false);
    expect(grantIsStale(null, '2026-10-01T00:00:00.000Z')).toBe(false);
  });

  it('is stale when the account changed after the answer the client saw', () => {
    expect(grantIsStale(denial, '2026-10-02T08:00:00.122Z')).toBe(true);
    expect(grantIsStale(grant, '2026-10-01T00:00:00.000Z')).toBe(true);
  });

  it('is not stale when the client saw exactly the current answer', () => {
    // Millisecond echo of a microsecond column must read as "the same answer".
    expect(grantIsStale(denial, '2026-10-02T08:00:00.123Z')).toBe(false);
  });

  it('with no basedOnDecidedAt, is stale only against a different answer', () => {
    expect(grantIsStale(denial, null)).toBe(true);
    expect(grantIsStale(grant, null)).toBe(false);
    expect(grantIsStale(grant, undefined)).toBe(false);
  });
});

describe('account deletion', () => {
  it('cascades consent and activity rows away with the user', async () => {
    const userId = await createUser();
    await setConsent(userId, grantFromPhone(null));
    await db.insert(dbSchema.userActivityDays).values({ userId, day: '2026-10-01', platform: 'ios' });

    await db.delete(dbSchema.users).where(eq(dbSchema.users.id, userId));

    expect(await storedRows(userId)).toHaveLength(0);
    const activity = await db
      .select()
      .from(dbSchema.userActivityDays)
      .where(eq(dbSchema.userActivityDays.userId, userId));
    expect(activity).toHaveLength(0);
  });
});
