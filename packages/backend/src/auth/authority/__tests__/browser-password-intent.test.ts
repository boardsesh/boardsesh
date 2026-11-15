import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { authBrowserBindings, type authBrowserIntents } from '@boardsesh/db/schema/auth';
import type { AuthorityTransaction } from '../adapter';
const dependencies = vi.hoisted(() => ({ revalidate: vi.fn(), session: vi.fn(), subject: vi.fn() }));
vi.mock('../router', () => ({ revalidateIdentityAuthority: dependencies.revalidate }));
vi.mock('../session-reader', () => ({ readFirstPartySession: dependencies.session }));
vi.mock('../../current-store/web-credential-state', () => ({ readLockedWebSubjectState: dependencies.subject }));
import { beginBrowserLoginInTransaction } from '../browser-binding';
const authority = {
  projectionId: 'projection',
  normalizerVersion: 'normalizer',
  authority: 'current-store' as const,
  epoch: 1,
};
const now = new Date('2026-11-15T17:00:00.123Z');
const source = {
  userId: 'source-A',
  authSessionId: 'source-A-SID',
  generation: 1,
  authenticatedAt: null,
  linkGuarded: false,
  requiresAccountCutoff: false,
  expiresAt: new Date(now.getTime() + 4_000),
};
const hash = (input: string) => createHash('sha256').update(input).digest('hex');
function fixture(anonymous = false) {
  const binding: typeof authBrowserBindings.$inferSelect = {
    id: hash('b'.repeat(43)),
    version: 7,
    intentRevision: 4,
    createdAt: new Date(0),
    expiresAt: new Date(now.getTime() + 10_000),
    userId: anonymous ? null : source.userId,
    credentialKind: anonymous ? null : 'canonical-token',
    authSessionId: anonymous ? null : source.authSessionId,
    generation: anonymous ? null : source.generation,
    authenticatedAt: null,
    linkGuarded: false,
    requiresAccountCutoff: false,
    credentialExpiresAt: anonymous ? null : source.expiresAt,
  };
  const intents: (typeof authBrowserIntents.$inferInsert)[] = [];
  const stateReads: string[] = [];
  const transaction = {
    execute: vi.fn(async () => [{ now }]),
    select: (fields?: Record<string, unknown>) => ({
      from: () => ({
        where: () => {
          const rows =
            fields && 'state' in fields
              ? (() => {
                  const state = JSON.stringify(binding);
                  stateReads.push(state);
                  return [{ state }];
                })()
              : [binding];
          return Object.assign(Promise.resolve(rows), { for: async () => rows });
        },
      }),
    }),
    update: () => ({
      set: (patch: Partial<typeof binding>) => ({
        where: async () => {
          Object.assign(binding, patch);
        },
      }),
    }),
    insert: () => ({
      values: async (intent: typeof authBrowserIntents.$inferInsert) => {
        intents.push(intent);
      },
    }),
  };
  return { transaction: transaction as unknown as AuthorityTransaction, binding, intents, stateReads };
}
beforeEach(() => {
  vi.resetAllMocks();
  dependencies.session.mockResolvedValue({ status: 'admitted', session: source });
});
describe('transaction-owned browser password intent seam', () => {
  it('admits positive anonymous state and hashes the complete row after its own revision', async () => {
    const current = fixture(true);
    const reply = await beginBrowserLoginInTransaction(current.transaction, authority, {
      bindingToken: 'b'.repeat(43),
      expectedVersion: 7,
      expectedSourceUserId: null,
      maximumLifetimeMs: 60_000,
    });
    expect(reply.status).toBe('prepared');
    if (reply.status !== 'prepared') throw new Error('Expected prepared intent');
    expect(reply.sourceIntentRevision).toBe(4);
    expect(reply.intentRevision).toBe(5);
    expect(current.binding.intentRevision).toBe(5);
    expect(current.stateReads).toEqual([JSON.stringify(current.binding)]);
    expect(reply.preparedStateHash).toBe(
      hash(JSON.stringify(['browser-password-prepared-state-v1', JSON.stringify(current.binding)])),
    );
    expect(reply.cursor.bindingExpiresAt).toEqual(new Date(now.getTime() + 10_000));
    expect(current.intents[0]).toMatchObject({ expectedVersion: 7, revision: 5, actorCredentialHash: null });
    expect(dependencies.session).not.toHaveBeenCalled();
  });
  it('uses actual source admission and bounds its intent by the shorter source expiry', async () => {
    const current = fixture();
    const reply = await beginBrowserLoginInTransaction(current.transaction, authority, {
      bindingToken: 'b'.repeat(43),
      expectedVersion: 7,
      expectedSourceUserId: source.userId,
      actor: { version: 7, credential: { kind: 'canonical-token', token: 'actual-source-token' } },
      maximumLifetimeMs: 60_000,
    });
    expect(reply.status).toBe('prepared');
    if (reply.status !== 'prepared') throw new Error('Expected prepared intent');
    expect(reply.expiresAt).toEqual(source.expiresAt);
    expect(reply.sourceSession).toEqual(source);
    expect(current.intents[0].actorCredentialHash).toMatch(/^[a-f0-9]{64}$/);
  });
  it('does not read an unexpected subject C for an actor presented against selected A', async () => {
    const current = fixture();
    dependencies.session.mockImplementation(
      async (_transaction, _credential, _now, readSubject: (userId: string) => Promise<unknown>) => {
        expect(await readSubject('unexpected-C')).toBeUndefined();
        return { status: 'admitted', session: { ...source, userId: 'unexpected-C' } };
      },
    );
    const reply = await beginBrowserLoginInTransaction(current.transaction, authority, {
      bindingToken: 'b'.repeat(43),
      expectedVersion: 7,
      expectedSourceUserId: source.userId,
      actor: { version: 7, credential: { kind: 'canonical-token', token: 'valid-C-token' } },
      maximumLifetimeMs: 60_000,
    });
    expect(reply.status).toBe('denied');
    expect(dependencies.subject).not.toHaveBeenCalled();
    expect(current.intents).toEqual([]);
    expect(current.binding.intentRevision).toBe(4);
  });
  it('refuses a selected row without its actual actor instead of treating it as anonymous', async () => {
    const current = fixture();
    expect(
      (
        await beginBrowserLoginInTransaction(current.transaction, authority, {
          bindingToken: 'b'.repeat(43),
          expectedVersion: 7,
          expectedSourceUserId: source.userId,
          maximumLifetimeMs: 60_000,
        })
      ).status,
    ).toBe('denied');
    expect(dependencies.session).not.toHaveBeenCalled();
    expect(current.intents).toEqual([]);
  });
  it('refuses a changed source owner before any unexpected subject admission', async () => {
    const current = fixture();
    current.binding.userId = 'later-C';
    expect(
      (
        await beginBrowserLoginInTransaction(current.transaction, authority, {
          bindingToken: 'b'.repeat(43),
          expectedVersion: 7,
          expectedSourceUserId: source.userId,
          maximumLifetimeMs: 60_000,
        })
      ).status,
    ).toBe('conflict');
    expect(dependencies.session).not.toHaveBeenCalled();
    expect(current.intents).toEqual([]);
  });
});
