import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { asc, eq, inArray } from 'drizzle-orm';
import type { ConnectionContext, SetProjectNewsEmailConsentInput } from '@boardsesh/shared-schema';
import * as dbSchema from '@boardsesh/db/schema';
import { db } from '../db/client';
import { projectNewsEmailMutations, projectNewsEmailQueries } from '../graphql/resolvers/users/project-news-email';
import { selectProjectNewsRecipients, setProjectNewsEmailConsent } from '../services/project-news-email';
import {
  createProjectNewsUnsubscribeToken,
  PROJECT_NEWS_UNSUBSCRIBE_SECRET_ENV,
  PROJECT_NEWS_UNSUBSCRIBE_TOKEN_LIFETIME_SECONDS,
} from '../services/project-news-unsubscribe-token';
import { handleProjectNewsUnsubscribe } from '../handlers/project-news-unsubscribe';
import { buildUserDataArchive } from '../services/user-data-export-archive';
import { resetAllRateLimits } from '../utils/rate-limiter';

/**
 * Real-DB coverage for "Email me project news" (docs/project-news-email.md):
 * off by default, a history row only when the answer changes, the signed
 * unsubscribe link, the send query, deletion and the data export.
 */

const SECRET = 'test-secret-that-is-at-least-thirty-two-characters-long';
const originalSecret = process.env[PROJECT_NEWS_UNSUBSCRIBE_SECRET_ENV];

let connectionCounter = 0;
const authCtx = (userId: string): ConnectionContext =>
  ({ connectionId: `news-${userId}-${connectionCounter++}`, isAuthenticated: true, userId }) as ConnectionContext;
const anonCtx = (): ConnectionContext =>
  ({ connectionId: `news-anon-${connectionCounter++}`, isAuthenticated: false }) as ConnectionContext;

async function createUser({ verified = true }: { verified?: boolean } = {}): Promise<string> {
  const userId = randomUUID();
  await db
    .insert(dbSchema.users)
    .values({ id: userId, email: `${userId}@example.invalid`, emailVerified: verified ? new Date() : null });
  return userId;
}

function setConsent(userId: string, input: SetProjectNewsEmailConsentInput) {
  return projectNewsEmailMutations.setProjectNewsEmailConsent(null, { input }, authCtx(userId));
}

function readConsent(userId: string) {
  return projectNewsEmailQueries.myProjectNewsEmailConsent(null, {}, authCtx(userId));
}

function storedRows(userId: string) {
  return db
    .select()
    .from(dbSchema.userProjectNewsEmailEvents)
    .where(eq(dbSchema.userProjectNewsEmailEvents.userId, userId))
    .orderBy(asc(dbSchema.userProjectNewsEmailEvents.id));
}

type MockRes = {
  statusCode: number;
  body: string;
  headers: Record<string, string>;
  writeHead: (status: number, headers?: Record<string, string>) => void;
  end: (body?: string) => void;
};

async function callUnsubscribe(method: 'GET' | 'POST' | 'HEAD', token: string | null) {
  const res: MockRes = {
    statusCode: 0,
    body: '',
    headers: {},
    writeHead(status, headers) {
      this.statusCode = status;
      if (headers) Object.assign(this.headers, headers);
    },
    end(body) {
      this.body = body ?? '';
    },
  };
  const url = new URL('https://ws.example.test/api/project-news/unsubscribe');
  if (token !== null) url.searchParams.set('token', token);
  const req = { method, resume: () => undefined } as unknown as IncomingMessage;
  await handleProjectNewsUnsubscribe(req, res as unknown as ServerResponse, url);
  return res;
}

beforeEach(() => {
  resetAllRateLimits();
  process.env[PROJECT_NEWS_UNSUBSCRIBE_SECRET_ENV] = SECRET;
});

afterEach(() => {
  if (originalSecret === undefined) delete process.env[PROJECT_NEWS_UNSUBSCRIBE_SECRET_ENV];
  else process.env[PROJECT_NEWS_UNSUBSCRIBE_SECRET_ENV] = originalSecret;
});

describe('project news email: authentication', () => {
  it('refuses the query without a signed-in climber', async () => {
    await expect(projectNewsEmailQueries.myProjectNewsEmailConsent(null, {}, anonCtx())).rejects.toThrow(
      'Authentication required',
    );
  });

  it('refuses the mutation without a signed-in climber and writes nothing', async () => {
    const before = await db.select().from(dbSchema.userProjectNewsEmailEvents);
    await expect(
      projectNewsEmailMutations.setProjectNewsEmailConsent(
        null,
        { input: { subscribed: true, source: 'ios' } },
        anonCtx(),
      ),
    ).rejects.toThrow('Authentication required');
    expect(await db.select().from(dbSchema.userProjectNewsEmailEvents)).toHaveLength(before.length);
  });

  it('only ever reads and writes the signed-in climber', async () => {
    const climber = await createUser();
    const someoneElse = await createUser();
    await setConsent(climber, { subscribed: true, source: 'ios' });
    expect((await readConsent(climber)).subscribed).toBe(true);
    expect(await readConsent(someoneElse)).toEqual({ subscribed: false, decidedAt: null });
    expect(await storedRows(someoneElse)).toHaveLength(0);
  });
});

describe('project news email: the switch', () => {
  it('is off for a climber who never answered', async () => {
    const userId = await createUser();
    expect(await readConsent(userId)).toEqual({ subscribed: false, decidedAt: null });
    expect(await storedRows(userId)).toHaveLength(0);
  });

  it('turning it off when it was never on writes nothing', async () => {
    const userId = await createUser();
    expect(await setConsent(userId, { subscribed: false, source: 'web' })).toEqual({
      subscribed: false,
      decidedAt: null,
    });
    expect(await storedRows(userId)).toHaveLength(0);
  });

  it('keeps one row per change of mind, with where and when, and the newest wins', async () => {
    const userId = await createUser();
    const on = await setConsent(userId, { subscribed: true, source: 'ios' });
    expect(on.subscribed).toBe(true);
    expect(on.decidedAt).not.toBeNull();
    // A repeated tap is not a new answer.
    expect(await setConsent(userId, { subscribed: true, source: 'android' })).toEqual(on);
    const off = await setConsent(userId, { subscribed: false, source: 'web' });
    const onAgain = await setConsent(userId, { subscribed: true, source: 'android' });

    const rows = await storedRows(userId);
    expect(rows.map((row) => [row.subscribed, row.source])).toEqual([
      [true, 'ios'],
      [false, 'web'],
      [true, 'android'],
    ]);
    expect(rows.map((row) => row.decidedAt.toISOString())).toEqual([on.decidedAt, off.decidedAt, onAgain.decidedAt]);
    expect(rows[1].decidedAt.getTime()).toBeGreaterThanOrEqual(rows[0].decidedAt.getTime());
    expect(await readConsent(userId)).toEqual(onAgain);
  });

  it('refuses a source the clients may not claim, including the email link', async () => {
    const userId = await createUser();
    await expect(
      setConsent(userId, { subscribed: true, source: 'email_link' } as unknown as SetProjectNewsEmailConsentInput),
    ).rejects.toThrow();
    await expect(
      setConsent(userId, { subscribed: true, source: 'desktop' } as unknown as SetProjectNewsEmailConsentInput),
    ).rejects.toThrow();
    expect(await storedRows(userId)).toHaveLength(0);
  });

  it('keeps the answer in order when two devices flip it at once', async () => {
    const userId = await createUser();
    await Promise.all([
      setProjectNewsEmailConsent(userId, true, 'ios'),
      setProjectNewsEmailConsent(userId, true, 'android'),
      setProjectNewsEmailConsent(userId, true, 'web'),
    ]);
    // Serialized by the per-user lock: the first writes, the other two find it on.
    const rows = await storedRows(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0].subscribed).toBe(true);
  });

  it('the database refuses a source outside the CHECK constraint', async () => {
    const userId = await createUser();
    await expect(
      db.insert(dbSchema.userProjectNewsEmailEvents).values({ userId, subscribed: true, source: 'desktop' }),
    ).rejects.toThrow();
  });
});

describe('project news email: unsubscribe link', () => {
  it('a GET shows the button and changes nothing', async () => {
    const userId = await createUser();
    await setProjectNewsEmailConsent(userId, true, 'ios');
    const res = await callUnsubscribe('GET', createProjectNewsUnsubscribeToken(userId));
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<form method="post" action="">');
    expect(res.headers['Referrer-Policy']).toBe('no-referrer');
    expect(res.headers['Cache-Control']).toBe('no-store');
    expect((await readConsent(userId)).subscribed).toBe(true);
    // HEAD (link scanners) changes nothing either and sends no body.
    const head = await callUnsubscribe('HEAD', createProjectNewsUnsubscribeToken(userId));
    expect(head.statusCode).toBe(200);
    expect(head.body).toBe('');
    expect((await readConsent(userId)).subscribed).toBe(true);
  });

  it('a POST with a valid token switches it off without a sign-in, recorded as the email link', async () => {
    const userId = await createUser();
    await setProjectNewsEmailConsent(userId, true, 'ios');
    const res = await callUnsubscribe('POST', createProjectNewsUnsubscribeToken(userId));
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("You're unsubscribed");
    expect((await readConsent(userId)).subscribed).toBe(false);
    expect((await storedRows(userId)).map((row) => [row.subscribed, row.source])).toEqual([
      [true, 'ios'],
      [false, 'email_link'],
    ]);
    // A second click (or the mail app's one-click POST after the button) adds nothing.
    expect((await callUnsubscribe('POST', createProjectNewsUnsubscribeToken(userId))).statusCode).toBe(200);
    expect(await storedRows(userId)).toHaveLength(2);
  });

  it('refuses a tampered, missing or wrong-secret token and leaves the answer alone', async () => {
    const userId = await createUser();
    await setProjectNewsEmailConsent(userId, true, 'ios');
    const token = createProjectNewsUnsubscribeToken(userId);
    const tampered = `${token.slice(0, -2)}${token.endsWith('AA') ? 'BB' : 'AA'}`;
    for (const candidate of [tampered, 'not-a-token', null]) {
      const res = await callUnsubscribe('POST', candidate);
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain('does not work');
    }
    process.env[PROJECT_NEWS_UNSUBSCRIBE_SECRET_ENV] = 'a-different-secret-that-is-at-least-32-chars';
    expect((await callUnsubscribe('POST', token)).statusCode).toBe(400);
    expect((await readConsent(userId)).subscribed).toBe(true);
  });

  it('refuses an expired token and says so', async () => {
    const userId = await createUser();
    await setProjectNewsEmailConsent(userId, true, 'ios');
    const mintedAt = Date.now() - (PROJECT_NEWS_UNSUBSCRIBE_TOKEN_LIFETIME_SECONDS + 60) * 1000;
    const res = await callUnsubscribe('POST', createProjectNewsUnsubscribeToken(userId, mintedAt));
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('expired');
    expect((await readConsent(userId)).subscribed).toBe(true);
  });

  it('answers 503 when the secret is not configured', async () => {
    const userId = await createUser();
    const token = createProjectNewsUnsubscribeToken(userId);
    delete process.env[PROJECT_NEWS_UNSUBSCRIBE_SECRET_ENV];
    expect((await callUnsubscribe('POST', token)).statusCode).toBe(503);
  });

  it('a valid link for a deleted account is a quiet success', async () => {
    const userId = await createUser();
    const token = createProjectNewsUnsubscribeToken(userId);
    await db.delete(dbSchema.users).where(eq(dbSchema.users.id, userId));
    expect((await callUnsubscribe('POST', token)).statusCode).toBe(200);
  });
});

describe('project news email: who a send may reach', () => {
  it('returns only verified accounts whose newest answer is on', async () => {
    const optedIn = await createUser();
    const optedInUnverified = await createUser({ verified: false });
    const optedOut = await createUser();
    const unsubscribedByLink = await createUser();
    const neverAnswered = await createUser();
    await setProjectNewsEmailConsent(optedIn, true, 'ios');
    await setProjectNewsEmailConsent(optedInUnverified, true, 'android');
    await setProjectNewsEmailConsent(optedOut, true, 'web');
    await setProjectNewsEmailConsent(optedOut, false, 'web');
    await setProjectNewsEmailConsent(unsubscribedByLink, true, 'ios');
    await setProjectNewsEmailConsent(unsubscribedByLink, false, 'email_link');

    const fixtureIds = [optedIn, optedInUnverified, optedOut, unsubscribedByLink, neverAnswered];
    const recipients = (await selectProjectNewsRecipients()).filter((recipient) =>
      fixtureIds.includes(recipient.userId),
    );
    expect(recipients).toEqual([{ userId: optedIn, email: `${optedIn}@example.invalid`, name: null }]);
  });
});

describe('project news email: account deletion and data export', () => {
  it('deleting the account deletes its history', async () => {
    const userId = await createUser();
    await setProjectNewsEmailConsent(userId, true, 'ios');
    await setProjectNewsEmailConsent(userId, false, 'web');
    await db.delete(dbSchema.users).where(eq(dbSchema.users.id, userId));
    const left = await db
      .select()
      .from(dbSchema.userProjectNewsEmailEvents)
      .where(inArray(dbSchema.userProjectNewsEmailEvents.userId, [userId]));
    expect(left).toHaveLength(0);
  });

  it('the data export carries every answer, oldest first', async () => {
    const userId = await createUser();
    const on = await setProjectNewsEmailConsent(userId, true, 'ios');
    const off = await setProjectNewsEmailConsent(userId, false, 'email_link');
    const archive = await buildUserDataArchive(db, userId, 'kilter', '2026-W44');
    expect(archive.projectNewsEmail).toEqual([
      { subscribed: true, source: 'ios', decidedAt: on.consent.decidedAt },
      { subscribed: false, source: 'email_link', decidedAt: off.consent.decidedAt },
    ]);
  });

  it('the data export carries an empty list for a climber who never answered', async () => {
    const userId = await createUser();
    const archive = await buildUserDataArchive(db, userId, 'kilter', '2026-W44');
    expect(archive.projectNewsEmail).toEqual([]);
  });
});
