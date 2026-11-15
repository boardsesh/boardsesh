import { getTableName, type Table } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { randomUUID } from 'node:crypto';
import {
  authBrowserBindings,
  authBrowserIntents,
  authSession,
  users,
  verificationTokens,
} from '@boardsesh/db/schema/auth';
import type { BrowserPasswordCommand, BrowserPasswordPreparation } from '@boardsesh/auth-protocol/browser-password-v1';
import type { AuthorityDatabase } from '../adapter';
import type { WebPasswordCandidate } from '../../current-store/web-password';
import {
  BROWSER_PASSWORD_RECEIPT_PREFIX,
  browserPasswordCredentialHash,
  browserPasswordHash,
  browserPasswordReceiptHash,
  browserPasswordStateHash,
  browserPasswordTokenHash,
} from '../browser-password-policy';
const dependencies = vi.hoisted(() => ({
  prepare: vi.fn(),
  lockPassword: vi.fn(),
  readPassword: vi.fn(),
  begin: vi.fn(),
  commit: vi.fn(),
  readBinding: vi.fn(),
  capture: vi.fn(),
  revalidate: vi.fn(),
  clock: vi.fn(),
  proof: vi.fn(),
  readSession: vi.fn(),
  verifyLegacy: vi.fn(),
  claim: vi.fn(),
  fresh: vi.fn(),
}));
vi.mock('../../current-store/web-password', () => ({
  prepareWebPasswordAuthentication: dependencies.prepare,
  lockWebPasswordAuthentication: dependencies.lockPassword,
  readWebPasswordCandidateInTransaction: dependencies.readPassword,
}));
vi.mock('../browser-binding', () => ({
  beginBrowserLoginInTransaction: dependencies.begin,
  commitBrowserLoginInTransaction: dependencies.commit,
  readBrowserBindingInTransaction: dependencies.readBinding,
}));
vi.mock('../router', () => ({
  captureIdentityAuthority: dependencies.capture,
  revalidateIdentityAuthority: dependencies.revalidate,
}));
vi.mock('../provider-security-context', () => ({ providerDatabaseNow: dependencies.clock }));
vi.mock('../../current-store/web-credential-proof', () => ({ issueWebCredentialProof: dependencies.proof }));
vi.mock('../session-reader', () => ({ readFirstPartySession: dependencies.readSession }));
vi.mock('../../legacy-web-credentials', () => ({ verifyLegacyNextAuthJwe: dependencies.verifyLegacy }));
vi.mock('../../current-store/web-credential-state', () => ({ readLockedWebSubjectState: vi.fn() }));
vi.mock('../../current-store/command-context', () => ({
  assertFresh: dependencies.fresh,
  claimCommand: dependencies.claim,
  captureAuthority: (authority: unknown) => authority,
  transactionSettings: vi.fn(),
  boundSignInLockWaits: vi.fn(),
}));
import { executeBrowserPasswordCommand } from '../browser-password';

const authority = {
  projectionId: 'owned-projection',
  normalizerVersion: 'owned-normalizer',
  authority: 'current-store' as const,
  epoch: 1,
};
const runtime = {
  authority: {
    expectedProjectionId: authority.projectionId,
    expectedNormalizerVersion: authority.normalizerVersion,
    expectedWriterEpoch: 1,
    emailVerificationEnabled: true,
  },
  legacySecret: 'trusted-runtime-reader-secret',
};
const bindingToken = 'b'.repeat(43),
  operationToken = 'o'.repeat(43),
  browserIntentToken = 'i'.repeat(43);
const targetToken = 't'.repeat(43),
  sourceToken = 's'.repeat(43);
const fullRowState = 'exact PostgreSQL row after this own intent';
let now: Date;
let preparation: BrowserPasswordPreparation;
let candidate: WebPasswordCandidate;
let session: {
  userId: string;
  authSessionId: string;
  generation: number;
  authenticatedAt: Date;
  linkGuarded: boolean;
  requiresAccountCutoff: boolean;
  expiresAt: Date;
};
type Row = Record<string, unknown>;
type Store = Record<string, Row[]>;

/** Transactional test double only; SQL predicates and row locks require the
 * separately coordinated PostgreSQL proof. This detects escaped writes/ACKs. */
function fixture(completed = false) {
  const pendingBinding = {
    id: preparation.browserCursor.bindingId,
    userId: preparation.source.state === 'selected' ? preparation.source.credentialProof.userId : null,
    version: 7,
    intentRevision: preparation.intentRevision,
    expiresAt: new Date(preparation.browserCursor.bindingExpiresAt),
  };
  let store: Store = {
    [getTableName(authBrowserBindings)]: [
      { ...pendingBinding, ...(completed ? { userId: session.userId, version: 8 } : {}) },
    ],
    [getTableName(authBrowserIntents)]: [
      {
        id: browserPasswordTokenHash(browserIntentToken),
        bindingId: pendingBinding.id,
        revision: preparation.intentRevision,
        expectedVersion: 7,
        operation: 'login',
        formatVersion: 2,
        consumedAt: completed ? now : null,
        resultVersion: completed ? 8 : null,
        resultCredentialHash: completed
          ? browserPasswordCredentialHash({ kind: 'canonical-token', token: targetToken })
          : null,
        projectionId: authority.projectionId,
        authority: authority.authority,
        epoch: authority.epoch,
        createdAt: new Date(preparation.preparedAt),
        expiresAt: new Date(preparation.expiresAt),
      },
    ],
    [getTableName(verificationTokens)]: [
      {
        identifier: BROWSER_PASSWORD_RECEIPT_PREFIX + browserPasswordTokenHash(operationToken),
        token: browserPasswordReceiptHash(
          operationToken,
          browserIntentToken,
          preparation,
          completed ? 'completed' : 'prepared',
          completed ? browserPasswordCredentialHash({ kind: 'canonical-token', token: targetToken }) : undefined,
        ),
        expires: new Date(preparation.acknowledgeUntil),
      },
    ],
    [getTableName(authSession)]: [],
    [getTableName(users)]: [{ id: session.userId }],
  };
  const committedWrites: string[] = [],
    attemptedWrites: string[] = [],
    reads: string[] = [];
  const transaction = vi.fn(async (work: (transaction: unknown) => Promise<unknown>) => {
    const current = structuredClone(store),
      writes: string[] = [];
    function query(table: unknown, result: () => Row[]) {
      const chain = Object.assign(Promise.resolve().then(result), {
        where: (_condition: unknown) => chain,
        orderBy: (_column: unknown) => chain,
        limit: (_count: number) => chain,
        for: (_mode: string) => chain,
        returning: (_fields: unknown) => chain,
      });
      void table;
      return chain;
    }
    const transactionApi = {
      select: (fields?: Record<string, unknown>) => ({
        from: (table: unknown) => {
          const name = getTableName(table as Table);
          return query(table, () => {
            reads.push(name);
            return fields && 'state' in fields ? [{ state: fullRowState }] : (current[name] ?? []);
          });
        },
      }),
      insert: (table: unknown) => ({
        values: async (row: Row) => {
          const name = getTableName(table as Table);
          attemptedWrites.push(name);
          writes.push(name);
          (current[name] ??= []).push(row);
        },
      }),
      update: (table: unknown) => ({
        set: (patch: Row) => {
          const name = getTableName(table as Table);
          return query(table, () => {
            attemptedWrites.push(name);
            writes.push(name);
            for (const row of current[name] ?? []) Object.assign(row, patch);
            return current[name] ?? [];
          });
        },
      }),
    };
    const result = await work(transactionApi);
    store = current;
    committedWrites.push(...writes);
    return result;
  });
  return {
    database: { transaction } as unknown as AuthorityDatabase,
    transaction,
    committedWrites,
    attemptedWrites,
    reads,
    rows: (table: Table) => store[getTableName(table)],
  };
}
function command(operation: 'finalize' | 'acknowledge' | 'abort' = 'finalize'): BrowserPasswordCommand {
  return {
    browserPasswordProtocolVersion: 1,
    requestId: randomUUID(),
    issuedAt: Date.now(),
    operation,
    payload: {
      source:
        preparation.source.state === 'selected'
          ? {
              state: 'selected',
              bindingToken,
              expectedVersion: 7,
              actor: { version: 7, credential: { kind: 'canonical-token', token: sourceToken } },
            }
          : { state: 'anonymous', bindingToken, expectedVersion: 7 },
      operationToken,
      browserIntentToken,
      preparation,
      ...(operation === 'abort' ? {} : { candidate: { kind: 'canonical-token', token: targetToken } }),
    },
  } as BrowserPasswordCommand;
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('DEBUG_SQL', 'false');
  now = new Date();
  const authenticatedAt = new Date(Math.floor((now.getTime() - 10) / 1_000) * 1_000);
  const proof = {
    version: 1 as const,
    userId: 'matched-B',
    authSessionId: 'fresh-B-SID',
    generation: 3,
    authenticatedAt: authenticatedAt.toISOString(),
    linkGuarded: true as const,
  };
  session = {
    ...proof,
    authenticatedAt,
    requiresAccountCutoff: false,
    expiresAt: new Date(authenticatedAt.getTime() + 30 * 86_400_000),
  };
  candidate = {
    userId: proof.userId,
    email: 'exact@example.test',
    name: null,
    image: null,
    createdAt: new Date(0),
    emailVerified: new Date(0),
    passwordHash: 'original-hash',
    generation: 3,
    deleted: false,
  };
  const cursor = {
    bindingId: browserPasswordTokenHash(bindingToken),
    version: 7,
    bindingExpiresAt: new Date(now.getTime() + 86_400_000).toISOString(),
  };
  preparation = {
    version: 1,
    purpose: 'browser-password-publication-v1',
    source: {
      state: 'selected',
      credentialKind: 'canonical-token',
      credentialHash: browserPasswordCredentialHash({ kind: 'canonical-token', token: sourceToken }),
      credentialProof: {
        version: 1,
        userId: 'source-A',
        authSessionId: 'old-A-SID',
        generation: 1,
        authenticatedAt: null,
        linkGuarded: false,
      },
      expiresAt: new Date(now.getTime() + 20_000).toISOString(),
    },
    browserCursor: cursor,
    sourceIntentRevision: 4,
    intentRevision: 5,
    preparedStateHash: browserPasswordHash(['browser-password-prepared-state-v1', fullRowState]),
    futureBrowserCursor: { ...cursor, version: 8 },
    authority,
    nonceHash: 'n'.repeat(64).replaceAll('n', 'e'),
    passwordStateHash: browserPasswordStateHash(candidate),
    credentialKind: 'canonical-token',
    passwordVerifiedAt: new Date(now.getTime() - 10).toISOString(),
    credentialProof: proof,
    credentialExpiresAt: session.expiresAt.toISOString(),
    proposedCanonicalTokenHash: browserPasswordCredentialHash({ kind: 'canonical-token', token: targetToken }),
    verification: { required: true, verified: true },
    preparedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 20_000).toISOString(),
    acknowledgeUntil: new Date(now.getTime() + 300_000).toISOString(),
  };
  dependencies.capture.mockResolvedValue(authority);
  dependencies.clock.mockImplementation(async () => now);
  dependencies.claim.mockResolvedValue(true);
  dependencies.readPassword.mockImplementation(async () => candidate);
  dependencies.lockPassword.mockImplementation(async () => candidate);
  dependencies.prepare.mockResolvedValue({
    receipt: authority,
    email: candidate.email,
    snapshot: [candidate],
    matchedUserId: candidate.userId,
  });
  dependencies.proof.mockResolvedValue({ ...proof, authenticatedAt: preparation.passwordVerifiedAt });
  dependencies.readSession.mockImplementation(async () => ({ status: 'admitted', session }));
  dependencies.readBinding.mockImplementation(async () => ({
    status: 'admitted',
    cursor: { ...cursor, bindingExpiresAt: new Date(cursor.bindingExpiresAt) },
    session:
      preparation.source.state === 'selected'
        ? {
            ...preparation.source.credentialProof,
            authenticatedAt: null,
            requiresAccountCutoff: false,
            expiresAt: new Date(preparation.source.expiresAt),
          }
        : session,
  }));
  dependencies.commit.mockImplementation(async () => ({
    status: 'committed',
    session,
    cursor: {
      ...preparation.futureBrowserCursor,
      bindingExpiresAt: new Date(preparation.futureBrowserCursor.bindingExpiresAt),
    },
  }));
  dependencies.begin.mockImplementation(async () => ({
    status: 'prepared',
    intentToken: browserIntentToken,
    cursor: { ...cursor, bindingExpiresAt: new Date(cursor.bindingExpiresAt) },
    sourceSession:
      preparation.source.state === 'selected'
        ? {
            ...preparation.source.credentialProof,
            authenticatedAt: null,
            requiresAccountCutoff: false,
            expiresAt: new Date(preparation.source.expiresAt),
          }
        : null,
    sourceIntentRevision: 4,
    intentRevision: 5,
    preparedStateHash: preparation.preparedStateHash,
    preparedAt: now,
    expiresAt: new Date(preparation.expiresAt),
  }));
});

describe('private browser password transaction boundaries', () => {
  it('uses the existing verifier and joins the owned intent with the hash-only preparation receipt', async () => {
    const current = fixture();
    current.rows(verificationTokens).length = 0;
    const request = {
      browserPasswordProtocolVersion: 1 as const,
      requestId: randomUUID(),
      issuedAt: Date.now(),
      operation: 'prepare' as const,
      payload: {
        source: command().payload.source,
        email: ' exact@example.test ',
        password: '  exact\u0000密码  ',
        credentialKind: 'canonical-token' as const,
        nonceHash: 'e'.repeat(64),
      },
    };
    const reply = await executeBrowserPasswordCommand(current.database, runtime, request);
    expect(reply.outcome).toBe('prepared');
    expect(dependencies.prepare).toHaveBeenCalledExactlyOnceWith(
      current.database,
      runtime.authority,
      request.payload.email,
      request.payload.password,
    );
    expect(dependencies.lockPassword.mock.calls[0][2]).toEqual(['source-A']);
    expect(dependencies.begin.mock.calls[0][0]).toBe(dependencies.lockPassword.mock.calls[0][0]);
    expect(current.transaction).toHaveBeenCalledTimes(1);
    expect(current.committedWrites).toEqual([getTableName(verificationTokens)]);
    expect(JSON.stringify(current.rows(verificationTokens))).not.toContain(request.payload.password);
    expect(JSON.stringify(current.rows(verificationTokens))).not.toContain(candidate.passwordHash);
    if (reply.outcome !== 'prepared') throw new Error('Expected prepared reply');
    expect(reply.preparation.credentialProof.authenticatedAt).toBe(session.authenticatedAt.toISOString());
    expect(reply.preparation.passwordVerifiedAt).toBe(preparation.passwordVerifiedAt);
    expect(reply.preparation.futureBrowserCursor.bindingExpiresAt).toBe(preparation.browserCursor.bindingExpiresAt);
  });
  it('takes no source or target account lock when the actual verifier matches nobody', async () => {
    const current = fixture();
    dependencies.prepare.mockResolvedValue({
      receipt: authority,
      email: candidate.email,
      snapshot: [candidate],
      matchedUserId: null,
    });
    const reply = await executeBrowserPasswordCommand(current.database, runtime, {
      browserPasswordProtocolVersion: 1,
      requestId: randomUUID(),
      issuedAt: Date.now(),
      operation: 'prepare',
      payload: {
        source: command().payload.source,
        email: candidate.email,
        password: 'wrong',
        credentialKind: 'canonical-token',
        nonceHash: 'e'.repeat(64),
      },
    });
    expect(reply.outcome).toBe('invalid_credentials');
    expect(current.reads).toEqual([]);
    expect(dependencies.lockPassword).not.toHaveBeenCalled();
    expect(dependencies.begin).not.toHaveBeenCalled();
  });
  it('commits canonical credential, existing login CAS and exact completion in one transaction', async () => {
    const current = fixture();
    expect((await executeBrowserPasswordCommand(current.database, runtime, command())).outcome).toBe('completed');
    expect(current.transaction).toHaveBeenCalledTimes(1);
    expect(current.committedWrites).toEqual([getTableName(authSession), getTableName(verificationTokens)]);
    expect(dependencies.commit).toHaveBeenCalledTimes(1);
    expect(current.rows(authSession)[0]).toMatchObject({
      id: session.authSessionId,
      originalAuthenticatedAt: session.authenticatedAt,
      expiresAt: session.expiresAt,
    });
  });
  it.each(['login-cas', 'final-clock'] as const)('rolls back all candidate writes after %s failure', async (fault) => {
    const current = fixture(),
      originalReceipt = current.rows(verificationTokens)[0].token;
    if (fault === 'login-cas') dependencies.commit.mockResolvedValue({ status: 'conflict' });
    else dependencies.clock.mockResolvedValueOnce(now).mockResolvedValueOnce(new Date(preparation.expiresAt));
    expect((await executeBrowserPasswordCommand(current.database, runtime, command())).outcome).toBe('conflict');
    expect(current.attemptedWrites).toContain(getTableName(authSession));
    expect(current.rows(authSession)).toEqual([]);
    expect(current.rows(verificationTokens)[0].token).toBe(originalReceipt);
    expect(current.committedWrites).toEqual([]);
  });
  it.each(['passwordHash', 'generation', 'emailVerified'] as const)(
    'refuses changed target %s before candidate creation',
    async (field) => {
      const current = fixture();
      if (field === 'passwordHash') candidate = { ...candidate, passwordHash: 'reset-hash' };
      if (field === 'generation') candidate = { ...candidate, generation: candidate.generation + 1 };
      if (field === 'emailVerified') candidate = { ...candidate, emailVerified: null };
      expect((await executeBrowserPasswordCommand(current.database, runtime, command())).outcome).toBe('conflict');
      expect(current.attemptedWrites).toEqual([]);
      expect(dependencies.commit).not.toHaveBeenCalled();
    },
  );
  it('does not refinalize an already completed receipt', async () => {
    const current = fixture(true);
    expect((await executeBrowserPasswordCommand(current.database, runtime, command())).outcome).toBe('conflict');
    expect(current.attemptedWrites).toEqual([]);
    expect(dependencies.commit).not.toHaveBeenCalled();
  });
  it('read-only ACK admits the exact current candidate after the original source deadline', async () => {
    const current = fixture(true);
    now = new Date(now.getTime() + 30_000);
    dependencies.readBinding.mockResolvedValue({
      status: 'admitted',
      session,
      cursor: preparation.futureBrowserCursor,
    });
    expect((await executeBrowserPasswordCommand(current.database, runtime, command('acknowledge'))).outcome).toBe(
      'completed',
    );
    expect(current.attemptedWrites).toEqual([]);
    expect(dependencies.commit).not.toHaveBeenCalled();
    expect(dependencies.prepare).not.toHaveBeenCalled();
    expect(dependencies.readPassword).not.toHaveBeenCalled();
    expect(dependencies.readSession.mock.calls[0][1]).toEqual({ kind: 'canonical-token', token: targetToken });
  });
  it.each(['candidate', 'revocation', 'later-intent', 'later-selection', 'ack-deadline'] as const)(
    'refuses ACK %s without writes or finalization',
    async (fault) => {
      const current = fixture(true),
        request = command('acknowledge');
      dependencies.readBinding.mockResolvedValue({
        status: 'admitted',
        session,
        cursor: preparation.futureBrowserCursor,
      });
      if (fault === 'candidate' && request.operation === 'acknowledge')
        request.payload.candidate = { kind: 'canonical-token', token: 'x'.repeat(43) };
      if (fault === 'revocation') dependencies.readSession.mockResolvedValue({ status: 'denied' });
      if (fault === 'later-intent')
        current.rows(authBrowserBindings)[0].intentRevision = preparation.intentRevision + 1;
      if (fault === 'later-selection') current.rows(authBrowserBindings)[0].version = 9;
      if (fault === 'ack-deadline') now = new Date(preparation.acknowledgeUntil);
      expect((await executeBrowserPasswordCommand(current.database, runtime, request)).outcome).not.toBe('completed');
      expect(current.attemptedWrites).toEqual([]);
      expect(dependencies.commit).not.toHaveBeenCalled();
    },
  );
  it('aborts only the exact pending intent, including after its original source expires', async () => {
    const current = fixture();
    now = new Date(now.getTime() + 30_000);
    expect((await executeBrowserPasswordCommand(current.database, runtime, command('abort'))).outcome).toBe('aborted');
    expect(current.committedWrites).toEqual([getTableName(authBrowserIntents), getTableName(verificationTokens)]);
    expect(current.rows(authBrowserIntents)[0]).toMatchObject({
      consumedAt: now,
      resultVersion: 8,
      resultCredentialHash: null,
    });
    expect(dependencies.commit).not.toHaveBeenCalled();
    expect(dependencies.readSession).not.toHaveBeenCalled();
  });
  it.each(['completed', 'newer-intent'] as const)('preserves %s when abort arrives late', async (state) => {
    const current = fixture(state === 'completed');
    if (state === 'newer-intent') current.rows(authBrowserBindings)[0].intentRevision = preparation.intentRevision + 1;
    expect((await executeBrowserPasswordCommand(current.database, runtime, command('abort'))).outcome).toBe('conflict');
    expect(current.attemptedWrites).toEqual([]);
  });
});
