import { randomUUID } from 'node:crypto';
import { IncomingMessage, type ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { accounts, mobileRefreshTokens, userCredentials, users } from '@boardsesh/db/schema/auth';

// BA-02 PR 2: every legacy account writer stores the normalized address and
// never adds a second account for an address another account holds in any
// capitalisation. Real PostgreSQL, real handlers; only the provider's token
// signature check is stubbed. Synthetic addresses only.

process.env.NEXTAUTH_SECRET ??= 'synthetic-secret-for-account-email-writer-tests';

vi.mock('jose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('jose')>();
  return { ...actual, createRemoteJWKSet: vi.fn(() => vi.fn()), jwtVerify: vi.fn() };
});

const { jwtVerify } = await import('jose');
const { db } = await import('../db/client');
const { handleNativeAuthOAuth, handleNativeAuthRegister, __resetNativeAuthStateForTests } =
  await import('../handlers/native-auth');

const seeded: string[] = [];

function host() {
  return `writers-${randomUUID().slice(0, 8)}.example.test`;
}

async function seed(email: string, options: { password?: boolean; verified?: boolean } = {}) {
  const id = randomUUID();
  await db.insert(users).values({
    id,
    email,
    name: 'Synthetic writer climber',
    emailVerified: options.verified === false ? null : new Date('2026-01-02T03:04:05Z'),
  });
  if (options.password !== false)
    await db.insert(userCredentials).values({ userId: id, passwordHash: '$2b$12$synthetic-not-a-real-hash' });
  seeded.push(id);
  return id;
}

async function usersHolding(domain: string) {
  return db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(sql`lower(${users.email}) like ${`%@${domain}`}`);
}

async function call(
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>,
  path: string,
  body: unknown,
) {
  const request = new IncomingMessage(new Socket());
  request.method = 'POST';
  request.url = path;
  request.headers = {};
  const captured = {
    statusCode: 0,
    body: '',
    writeHead(status: number) {
      this.statusCode = status;
    },
    setHeader() {},
    end(text?: string) {
      this.body = text ?? '';
    },
  };
  try {
    const handling = handler(request, captured as unknown as ServerResponse);
    request.emit('data', Buffer.from(JSON.stringify(body)));
    request.emit('end');
    await handling;
    const parsed: unknown = captured.body ? JSON.parse(captured.body) : null;
    return { status: captured.statusCode, body: parsed as Record<string, unknown> };
  } finally {
    request.destroy();
  }
}

function signInWithApple(sub: string, email: string, emailVerified = true) {
  vi.mocked(jwtVerify).mockResolvedValueOnce({
    payload: { sub, email, email_verified: emailVerified },
    protectedHeader: { alg: 'RS256' },
  } as Awaited<ReturnType<typeof jwtVerify>>);
  return call(handleNativeAuthOAuth, '/auth/native/oauth', { provider: 'apple', identityToken: 'stubbed-token' });
}

async function linkOwner(sub: string) {
  const [link] = await db
    .select({ userId: accounts.userId })
    .from(accounts)
    .where(and(eq(accounts.provider, 'apple'), eq(accounts.providerAccountId, sub)));
  return link?.userId;
}

beforeEach(() => {
  __resetNativeAuthStateForTests();
  vi.mocked(jwtVerify).mockReset();
});

afterEach(async () => {
  if (seeded.length) await db.delete(users).where(inArray(users.id, seeded.splice(0)));
});

describe('native registration', () => {
  it.each([
    ['in lowercase', (stored: string) => stored.toLowerCase()],
    ['in capitals', (stored: string) => stored.toUpperCase()],
  ])('refuses an address a mixed-case account holds, typed %s', async (_case, typed) => {
    const domain = host();
    const stored = `Mixed.Case@${domain}`;
    await seed(stored);

    const reply = await call(handleNativeAuthRegister, '/auth/native/register', {
      email: typed(stored),
      password: 'synthetic-password',
    });

    expect(reply.status).toBe(409);
    expect(await usersHolding(domain)).toHaveLength(1);
  });

  it('stores a new address in its normalized form', async () => {
    const domain = host();
    const reply = await call(handleNativeAuthRegister, '/auth/native/register', {
      email: `  New.Climber@${domain.toUpperCase()} `,
      password: 'synthetic-password',
    });
    expect(reply.status).toBe(201);
    const created = await usersHolding(domain);
    seeded.push(...created.map((row) => row.id));
    expect(created.map((row) => row.email)).toEqual([`new.climber@${domain}`]);
  });
});

describe('native Google and Apple sign-in (legacy mode)', () => {
  it('links to the account that stores the address in capitals, instead of creating another', async () => {
    const domain = host();
    const existing = await seed(`Mixed.Case@${domain}`, { verified: false });
    const sub = `apple-${randomUUID()}`;

    const reply = await signInWithApple(sub, `mixed.case@${domain}`);

    expect(reply.status).toBe(200);
    expect(reply.body.accountCreation).toMatchObject({ userId: existing, accountCreated: false });
    expect(await linkOwner(sub)).toBe(existing);
    expect(await usersHolding(domain)).toEqual([{ id: existing, email: `Mixed.Case@${domain}` }]);
  });

  it('links to the group member that stores the address exactly', async () => {
    const domain = host();
    await seed(`Shared@${domain}`);
    const lower = await seed(`shared@${domain}`);
    const sub = `apple-${randomUUID()}`;

    const reply = await signInWithApple(sub, `SHARED@${domain}`);

    expect(reply.status).toBe(200);
    expect(await linkOwner(sub)).toBe(lower);
  });

  it('refuses an address several accounts share in other capitals: no link, no new account', async () => {
    const domain = host();
    await seed(`Shared@${domain}`);
    await seed(`SHARED@${domain.toUpperCase()}`);
    const sub = `apple-${randomUUID()}`;

    const reply = await signInWithApple(sub, `shared@${domain}`);

    expect(reply.status).toBe(409);
    expect(await linkOwner(sub)).toBeUndefined();
    expect(await usersHolding(domain)).toHaveLength(2);
  });

  it('refuses an unverified provider address an account already holds, instead of creating another', async () => {
    const domain = host();
    await seed(`Taken@${domain}`);
    const sub = `apple-${randomUUID()}`;

    const reply = await signInWithApple(sub, `taken@${domain}`, false);

    expect(reply.status).toBe(409);
    expect(await linkOwner(sub)).toBeUndefined();
    expect(await usersHolding(domain)).toHaveLength(1);
  });

  it('creates a new account with the normalized address when nobody holds it', async () => {
    const domain = host();
    const sub = `apple-${randomUUID()}`;

    const reply = await signInWithApple(sub, `Brand.New@${domain.toUpperCase()}`);

    expect(reply.status).toBe(200);
    const created = await usersHolding(domain);
    seeded.push(...created.map((row) => row.id));
    expect(created.map((row) => row.email)).toEqual([`brand.new@${domain}`]);
    expect(await linkOwner(sub)).toBe(created[0]?.id);
  });

  it('never mints for the matched account when a concurrent sign-in linked the subject to another', async () => {
    const domain = host();
    const matched = await seed(`Raced@${domain}`);
    const other = await seed(`other@${host()}`);
    const sub = `apple-${randomUUID()}`;
    let releaseHolder = () => {};
    const holderMayCommit = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    let holderInserted = () => {};
    const inserted = new Promise<void>((resolve) => {
      holderInserted = resolve;
    });
    const holder = db.transaction(async (transaction) => {
      await transaction
        .insert(accounts)
        .values({ userId: other, type: 'oauth', provider: 'apple', providerAccountId: sub });
      holderInserted();
      await holderMayCommit;
    });
    try {
      await inserted;
      const signingIn = signInWithApple(sub, `raced@${domain}`);
      // The sign-in's link insert waits on the uncommitted row, then does nothing.
      const deadline = Date.now() + 3000;
      for (;;) {
        const [waiting] = await db.execute<{ waiting: boolean }>(
          sql`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock') AS waiting`,
        );
        if (waiting?.waiting) break;
        if (Date.now() > deadline) throw new Error('The sign-in never waited on the concurrent link');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      releaseHolder();
      await holder;

      const reply = await signingIn;

      expect(reply.status).toBe(409);
      expect(await linkOwner(sub)).toBe(other);
      expect(
        await db
          .select({ userId: mobileRefreshTokens.userId })
          .from(mobileRefreshTokens)
          .where(eq(mobileRefreshTokens.userId, matched)),
      ).toEqual([]);
    } finally {
      releaseHolder();
      await Promise.allSettled([holder]);
    }
  });
});
