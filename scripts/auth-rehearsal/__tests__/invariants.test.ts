import { randomBytes, randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vite-plus/test';
import { identityInvariant } from '../invariants';
import type { OwnedDatabase } from '../database';
function fixture() {
  const subject = randomUUID();
  const email = `${randomUUID()}@example.invalid`;
  const providerSubject = randomUUID();
  const state = {
    users: [{ id: subject, email, emailVerified: null as Date | null, name: 'Synthetic' }],
    providers: [{ userId: subject, provider: 'fixture', providerAccountId: providerSubject }],
    references: [
      { table_name: 'user_credentials', column_name: 'user_id' },
      { table_name: 'auth_session', column_name: 'user_id' },
    ],
    stableCount: 1,
    authCount: 1,
  };
  const query = vi.fn(async (template: TemplateStringsArray) => {
    const statement = template.join('');
    if (statement.includes('FROM users')) return state.users;
    if (statement.includes('FROM accounts')) return state.providers;
    return state.references;
  });
  const unsafe = vi.fn(async (statement: string) => [
    { count: statement.includes('"auth_session"') ? state.authCount : state.stableCount },
  ]);
  const assertMarker = vi.fn(async () => {});
  const database = {
    client: Object.assign(query, { unsafe }),
    assertMarker,
    target: { secrets: { reportKey: randomBytes(32) } },
  } as unknown as OwnedDatabase;
  return { database, state, unsafe, assertMarker, privateFields: [subject, email, providerSubject] };
}
it('reports only keyed identity references and counts', async () => {
  const { database, privateFields, assertMarker } = fixture();
  const report = await identityInvariant(database);
  expect(assertMarker).toHaveBeenCalledOnce();
  expect(report.userCount).toBe(1);
  expect(report.providerCount).toBe(1);
  const serialized = JSON.stringify(report);
  expect(privateFields.some((privateField) => serialized.includes(privateField))).toBe(false);
});
it('detects changed verification state and changed provider subjects', async () => {
  const { database, state } = fixture();
  const baseline = await identityInvariant(database);
  state.users[0].emailVerified = new Date();
  expect((await identityInvariant(database)).identityDigest === baseline.identityDigest).toBe(false);
  state.users[0].emailVerified = null;
  state.providers[0].providerAccountId = randomUUID();
  expect((await identityInvariant(database)).identityDigest === baseline.identityDigest).toBe(false);
});
it('detects stable reference loss while allowing intentional auth lineage count changes', async () => {
  const { database, state } = fixture();
  const baseline = await identityInvariant(database);
  state.authCount++;
  expect((await identityInvariant(database)).referenceDigest === baseline.referenceDigest).toBe(true);
  state.stableCount = 0;
  expect((await identityInvariant(database)).referenceDigest === baseline.referenceDigest).toBe(false);
});
it('refuses an unexpected catalog identifier before constructing a dynamic count query', async () => {
  const { database, state, unsafe } = fixture();
  state.references[0].table_name = 'unexpected;statement';
  await expect(identityInvariant(database)).rejects.toThrow('OWNED_REFERENCE_CATALOG_REFUSED');
  expect(unsafe).not.toHaveBeenCalled();
});

it('does not exclude an unlisted auth-prefixed reference from preservation', async () => {
  const { database, state } = fixture();
  state.references = [{ table_name: 'auth_unlisted_fixture_reference', column_name: 'user_id' }];
  const baseline = await identityInvariant(database);
  state.stableCount = 0;
  expect((await identityInvariant(database)).referenceDigest === baseline.referenceDigest).toBe(false);
});
