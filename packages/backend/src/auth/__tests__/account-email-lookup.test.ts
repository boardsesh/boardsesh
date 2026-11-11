import { randomUUID } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { ACCOUNT_EMAIL_CANDIDATE_LIMIT, soleAccount } from '@boardsesh/auth-protocol/account-email';
import { accountEmailCandidates, findAccountsByEmail } from '@boardsesh/db/queries/account-email';
import { userCredentials, users } from '@boardsesh/db/schema/auth';
import { db } from '../../db/client';

// BA-02 PR 1: the one address lookup the web's legacy sign-in, recovery and
// verification routes share, run against real PostgreSQL so the SQL half of the
// rule (lower(email) and its parameters) is proven, not just the resolver.
// Synthetic addresses only; each test uses its own random domain.

const seeded: string[] = [];

async function seed(email: string, passwordHash: string | null = '$2b$12$synthetic-hash-not-a-real-one') {
  const id = randomUUID();
  await db.insert(users).values({ id, email, name: 'Synthetic lookup climber' });
  if (passwordHash) await db.insert(userCredentials).values({ userId: id, passwordHash });
  seeded.push(id);
  return id;
}

function domain() {
  return `lookup-${randomUUID().slice(0, 8)}.example.test`;
}

afterEach(async () => {
  if (seeded.length) await db.delete(users).where(inArray(users.id, seeded.splice(0)));
});

describe('findAccountsByEmail against PostgreSQL', () => {
  it('finds a mixed-case stored address typed exactly as stored, in lowercase and in capitals', async () => {
    const host = domain();
    const stored = `Mixed.Case+Tag@${host.toUpperCase()}`;
    const id = await seed(stored);

    const exact = await findAccountsByEmail(db, stored);
    expect(exact.kind).toBe('exact');
    expect(soleAccount(exact)?.id).toBe(id);

    for (const typed of [stored.toLowerCase(), stored.toUpperCase(), `  ${stored.toLowerCase()} `]) {
      const found = await findAccountsByEmail(db, typed);
      expect(found.kind).toBe('normalized');
      expect(soleAccount(found)).toMatchObject({ id, email: stored });
    }
  });

  it('keeps the exact row first when a sibling stores the address in other capitals', async () => {
    const host = domain();
    const upper = await seed(`Shared@${host}`);
    const lower = await seed(`shared@${host}`);

    expect(soleAccount(await findAccountsByEmail(db, `Shared@${host}`))?.id).toBe(upper);
    expect(soleAccount(await findAccountsByEmail(db, `shared@${host}`))?.id).toBe(lower);
    expect(await findAccountsByEmail(db, `SHARED@${host.toUpperCase()}`)).toEqual({ kind: 'ambiguous', rows: [] });
  });

  it('returns every row storing the same text, with each password or null', async () => {
    const host = domain();
    const withPassword = await seed(`twin@${host}`);
    const providerOnly = await seed(`twin@${host}`, null);

    const found = await findAccountsByEmail(db, `twin@${host}`);

    expect(found.kind).toBe('exact');
    expect(new Map(found.rows.map((row) => [row.id, row.passwordHash !== null]))).toEqual(
      new Map([
        [withPassword, true],
        [providerOnly, false],
      ]),
    );
    expect(soleAccount(found)).toBeNull();
  });

  it('finds a row stored with surrounding spaces when it is typed exactly that way', async () => {
    const host = domain();
    const stored = ` Spaced@${host} `;
    const id = await seed(stored);

    expect(soleAccount(await findAccountsByEmail(db, stored))?.id).toBe(id);
  });

  it('treats LIKE wildcards in the typed text as literal characters', async () => {
    const host = domain();
    await seed(`a_b@${host}`);

    expect((await findAccountsByEmail(db, `a%b@${host}`)).kind).toBe('none');
    expect((await findAccountsByEmail(db, `aXb@${host}`)).kind).toBe('none');
  });

  it('refuses an address held by more rows than the candidate limit', async () => {
    const host = domain();
    for (let index = 0; index <= ACCOUNT_EMAIL_CANDIDATE_LIMIT; index += 1) await seed(`Crowd@${host}`, null);

    expect((await findAccountsByEmail(db, `Crowd@${host}`)).kind).toBe('ambiguous');
  });

  it('answers none for an address nobody has', async () => {
    expect(await findAccountsByEmail(db, `nobody@${domain()}`)).toEqual({ kind: 'none', rows: [] });
  });

  it('filters on lower(email), the expression the planned unique index covers', () => {
    const { sql: text, params } = new PgDialect().sqlToQuery(accountEmailCandidates(' Plan@Example.test'));
    expect(text).toBe('lower("users"."email") in ($1::text, lower($2::text))');
    expect(params).toEqual(['plan@example.test', ' Plan@Example.test']);
  });
});
