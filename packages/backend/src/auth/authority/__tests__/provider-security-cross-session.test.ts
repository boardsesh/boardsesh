import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import type { ProviderSecurityActor } from '@boardsesh/auth-protocol';
import {
  accounts,
  authAccount,
  authProviderReauthenticationReceipts,
  authProviderSecurityIntents,
  authSession,
  authSubjectCutoffs,
} from '@boardsesh/db/schema/auth';
import { createProviderSecurityEnvironment } from './provider-security-fixture';
import { finalizeProviderSecurityMutation, prepareProviderSecurityMutation } from '../provider-security-finalizer';
import { bindProviderSecurityFlow, createProviderSecurityIntent } from '../provider-security-intents';
import { reauthenticateProviderWithPassword } from '../provider-security-reauthentication';
import { abortProviderSecurityMutation, acknowledgeProviderSecurityResult } from '../provider-security-terminal';
import { providerTokenHash } from '../provider-security-context';
import { PROVIDER_SECURITY_LIVE_INTENTS_PER_SESSION } from '../provider-security-policy';
import { recordFunctionLevelIdentityMirrorForTests } from '../mirror-activation';

// #7596 B5c1 review S2-1: what the browser binding proved, the session token,
// the OAuth state hash and the intent phase now prove. Every refusal below
// writes nothing.
recordFunctionLevelIdentityMirrorForTests();

let environment: Awaited<ReturnType<typeof createProviderSecurityEnvironment>>;
type Owner = Awaited<ReturnType<typeof environment.actor>>;
const password = ' exact password ';

function appleProof(subject = randomUUID()) {
  return { provider: 'apple' as const, subject, email: 'verified@example.test', emailVerified: true };
}
/** Everything a refused command must leave alone. */
async function snapshot(intentToken: string, userIds: readonly string[]) {
  const intentHash = providerTokenHash(intentToken);
  return {
    intent: await environment.database
      .select()
      .from(authProviderSecurityIntents)
      .where(eq(authProviderSecurityIntents.intentHash, intentHash)),
    receipts: await environment.database
      .select()
      .from(authProviderReauthenticationReceipts)
      .where(eq(authProviderReauthenticationReceipts.intentHash, intentHash)),
    cutoffs: await environment.database
      .select()
      .from(authSubjectCutoffs)
      .where(inArray(authSubjectCutoffs.userId, [...userIds])),
    sessions: await environment.database
      .select()
      .from(authSession)
      .where(inArray(authSession.userId, [...userIds])),
    providers: [
      ...(await environment.database
        .select()
        .from(accounts)
        .where(inArray(accounts.userId, [...userIds]))),
      ...(await environment.database
        .select()
        .from(authAccount)
        .where(inArray(authAccount.userId, [...userIds]))),
    ],
  };
}
async function linked(userId: string, subject: string) {
  const rows = [
    ...(await environment.database
      .select()
      .from(accounts)
      .where(and(eq(accounts.userId, userId), eq(accounts.providerAccountId, subject)))),
    ...(await environment.database
      .select()
      .from(authAccount)
      .where(and(eq(authAccount.userId, userId), eq(authAccount.accountId, subject)))),
  ];
  return rows.length > 0;
}
async function intent(actor: ProviderSecurityActor) {
  const recorded = await createProviderSecurityIntent(environment.database, environment.runtime, {
    actor,
    action: 'link',
    provider: 'apple',
    methodId: null,
  });
  return { ...recorded, bound: { actor, intentToken: recorded.intentToken } };
}
/** Intent, flow bound, real password reauthentication, prepared. */
async function preparedLink(actor: ProviderSecurityActor) {
  const created = await intent(actor);
  const flowHash = randomBytes(32).toString('hex');
  await bindProviderSecurityFlow(environment.database, environment.runtime, { ...created.bound, flowHash });
  const proof = await reauthenticateProviderWithPassword(environment.database, environment.runtime, {
    ...created.bound,
    password,
  });
  const providerProof = appleProof();
  const prepared = await prepareProviderSecurityMutation(environment.database, environment.runtime, {
    ...created.bound,
    reauthenticationToken: proof.reauthenticationToken,
    flowHash,
    providerProof,
  });
  if (prepared.outcome !== 'prepared') throw new Error('Preparation refused');
  return { ...created, flowHash, providerProof, ...proof, preparationToken: prepared.preparationToken };
}

/**
 * Another live session presents the owner's intent, reauthentication and
 * preparation tokens at every step. Each is refused before any write.
 */
async function driveWithOtherSession(owner: Owner, other: ProviderSecurityActor, users: readonly string[]) {
  const pending = await intent(owner.webActor);
  const flowHash = randomBytes(32).toString('hex');
  const stolen = { actor: other, intentToken: pending.intentToken };
  let before = await snapshot(pending.intentToken, users);
  await expect(
    bindProviderSecurityFlow(environment.database, environment.runtime, { ...stolen, flowHash }),
  ).rejects.toMatchObject({ outcome: 'identity_changed' });
  await expect(
    reauthenticateProviderWithPassword(environment.database, environment.runtime, { ...stolen, password }),
  ).rejects.toMatchObject({ outcome: 'identity_changed' });
  expect(await snapshot(pending.intentToken, users)).toEqual(before);

  // The owner carries the same intent through to a prepared link.
  await bindProviderSecurityFlow(environment.database, environment.runtime, { ...pending.bound, flowHash });
  const proof = await reauthenticateProviderWithPassword(environment.database, environment.runtime, {
    ...pending.bound,
    password,
  });
  const providerProof = appleProof();
  const prepared = await prepareProviderSecurityMutation(environment.database, environment.runtime, {
    ...pending.bound,
    reauthenticationToken: proof.reauthenticationToken,
    flowHash,
    providerProof,
  });
  if (prepared.outcome !== 'prepared') throw new Error('Preparation refused');
  before = await snapshot(pending.intentToken, users);
  await expect(
    prepareProviderSecurityMutation(environment.database, environment.runtime, {
      ...stolen,
      reauthenticationToken: proof.reauthenticationToken,
      flowHash,
      providerProof,
    }),
  ).rejects.toMatchObject({ outcome: 'identity_changed' });
  await expect(
    finalizeProviderSecurityMutation(environment.database, environment.runtime, {
      ...stolen,
      reauthenticationToken: proof.reauthenticationToken,
      preparationToken: prepared.preparationToken,
    }),
  ).rejects.toMatchObject({ outcome: 'identity_changed' });
  await expect(
    abortProviderSecurityMutation(environment.database, environment.runtime, {
      ...stolen,
      preparationToken: prepared.preparationToken,
      flowHash,
    }),
  ).rejects.toMatchObject({ outcome: 'identity_changed' });
  const recovery = {
    ...stolen,
    recoveryToken: pending.recoveryToken,
    reauthenticationToken: proof.reauthenticationToken,
  };
  await expect(
    acknowledgeProviderSecurityResult(environment.database, environment.runtime, recovery),
  ).rejects.toMatchObject({ outcome: 'denied' });
  expect(await snapshot(pending.intentToken, users)).toEqual(before);
  expect(await linked(other.expectedUserId, providerProof.subject)).toBe(false);
  expect(await linked(owner.userId, providerProof.subject)).toBe(false);

  // The owner's own session still finishes; the other session still cannot ACK it.
  expect(
    await finalizeProviderSecurityMutation(environment.database, environment.runtime, {
      ...pending.bound,
      reauthenticationToken: proof.reauthenticationToken,
      preparationToken: prepared.preparationToken,
    }),
  ).toEqual({ outcome: 'committed', generation: 1 });
  await expect(
    acknowledgeProviderSecurityResult(environment.database, environment.runtime, recovery),
  ).rejects.toMatchObject({ outcome: 'denied' });
  expect(await linked(owner.userId, providerProof.subject)).toBe(true);
  expect(await linked(other.expectedUserId, providerProof.subject)).toBe(other.expectedUserId === owner.userId);
}

describe('provider security across sessions, callbacks and replays (#7596 B5c1)', () => {
  beforeAll(async () => {
    environment = await createProviderSecurityEnvironment();
  });
  afterAll(async () => environment?.close());

  it("another account's live session cannot drive this account's intent at any step", async () => {
    const owner = await environment.actor('better-auth', 'canonical-token');
    const other = await environment.actor('better-auth', 'canonical-token');
    await driveWithOtherSession(owner, other.webActor, [owner.userId, other.userId]);
    expect(
      await environment.database.select().from(authSubjectCutoffs).where(eq(authSubjectCutoffs.userId, other.userId)),
    ).toHaveLength(0);
  });

  it('a second live session of the same account (a new login mid-flow) cannot drive it either', async () => {
    const owner = await environment.actor('better-auth', 'canonical-token');
    await driveWithOtherSession(owner, (await environment.secondSession(owner)).webActor, [owner.userId]);
  });

  it('a callback with another state hash is not verified, writes no provider row and ends the intent', async () => {
    const owner = await environment.actor('better-auth', 'canonical-token');
    const created = await intent(owner.webActor);
    const flowHash = randomBytes(32).toString('hex');
    await bindProviderSecurityFlow(environment.database, environment.runtime, { ...created.bound, flowHash });
    const proof = await reauthenticateProviderWithPassword(environment.database, environment.runtime, {
      ...created.bound,
      password,
    });
    const providerProof = appleProof();
    expect(
      await prepareProviderSecurityMutation(environment.database, environment.runtime, {
        ...created.bound,
        reauthenticationToken: proof.reauthenticationToken,
        flowHash: randomBytes(32).toString('hex'),
        providerProof,
      }),
    ).toEqual({ outcome: 'denied', code: 'provider_not_verified' });
    expect(await linked(owner.userId, providerProof.subject)).toBe(false);
    const [row] = (await snapshot(created.intentToken, [owner.userId])).intent;
    expect(row).toMatchObject({ phase: 'terminal', flowHash });
    // The ended intent cannot be prepared again with the right hash.
    await expect(
      prepareProviderSecurityMutation(environment.database, environment.runtime, {
        ...created.bound,
        reauthenticationToken: proof.reauthenticationToken,
        flowHash,
        providerProof,
      }),
    ).rejects.toMatchObject({ outcome: 'denied', code: 'replayed' });
  });

  it('an intent binds one state hash once, and one state hash binds one intent', async () => {
    const owner = await environment.actor('better-auth', 'canonical-token');
    const first = await intent(owner.webActor);
    const flowHash = randomBytes(32).toString('hex');
    await bindProviderSecurityFlow(environment.database, environment.runtime, { ...first.bound, flowHash });
    await expect(
      bindProviderSecurityFlow(environment.database, environment.runtime, {
        ...first.bound,
        flowHash: randomBytes(32).toString('hex'),
      }),
    ).rejects.toMatchObject({ outcome: 'denied', code: 'invalid_intent' });
    expect((await snapshot(first.intentToken, [owner.userId])).intent[0].flowHash).toBe(flowHash);
    // Binding the same hash again to the same intent is idempotent.
    await bindProviderSecurityFlow(environment.database, environment.runtime, { ...first.bound, flowHash });
    const second = await intent(owner.webActor);
    // auth_provider_security_flow_idx: one (provider, state hash) for every intent.
    await expect(
      bindProviderSecurityFlow(environment.database, environment.runtime, { ...second.bound, flowHash }),
    ).rejects.toThrow();
    expect((await snapshot(second.intentToken, [owner.userId])).intent[0].flowHash).toBeNull();
  });

  it('a second prepare is a replay, and an aborted intent cannot be prepared or finalized', async () => {
    const owner = await environment.actor('better-auth', 'canonical-token');
    const link = await preparedLink(owner.webActor);
    const before = await snapshot(link.intentToken, [owner.userId]);
    await expect(
      prepareProviderSecurityMutation(environment.database, environment.runtime, {
        ...link.bound,
        reauthenticationToken: link.reauthenticationToken,
        flowHash: link.flowHash,
        providerProof: link.providerProof,
      }),
    ).rejects.toMatchObject({ outcome: 'denied', code: 'replayed' });
    expect(await snapshot(link.intentToken, [owner.userId])).toEqual(before);
    await abortProviderSecurityMutation(environment.database, environment.runtime, {
      ...link.bound,
      preparationToken: link.preparationToken,
      flowHash: link.flowHash,
    });
    const aborted = await snapshot(link.intentToken, [owner.userId]);
    expect(aborted.intent[0].phase).toBe('terminal');
    await expect(
      finalizeProviderSecurityMutation(environment.database, environment.runtime, {
        ...link.bound,
        reauthenticationToken: link.reauthenticationToken,
        preparationToken: link.preparationToken,
      }),
    ).rejects.toMatchObject({ outcome: 'denied', code: 'replayed' });
    expect(await snapshot(link.intentToken, [owner.userId])).toEqual(aborted);
    expect(await linked(owner.userId, link.providerProof.subject)).toBe(false);
  });

  it('a second finalize writes nothing: the session moved on, so it is refused before the phase check', async () => {
    const owner = await environment.actor('better-auth', 'canonical-token');
    const link = await preparedLink(owner.webActor);
    const command = {
      ...link.bound,
      reauthenticationToken: link.reauthenticationToken,
      preparationToken: link.preparationToken,
    };
    expect(await finalizeProviderSecurityMutation(environment.database, environment.runtime, command)).toEqual({
      outcome: 'committed',
      generation: 1,
    });
    const after = await snapshot(link.intentToken, [owner.userId]);
    // The intent was made at generation 0 and the session is at 1 now:
    // identity_changed, which is checked before the phase (`replayed`).
    await expect(
      finalizeProviderSecurityMutation(environment.database, environment.runtime, command),
    ).rejects.toMatchObject({ outcome: 'identity_changed' });
    expect(await snapshot(link.intentToken, [owner.userId])).toEqual(after);
    expect(after.cutoffs[0].generation).toBe(1);
  });

  it('one session holds at most five live intents; ending one frees a slot', async () => {
    const owner = await environment.actor('better-auth', 'canonical-token');
    const live = [];
    for (let index = 0; index < PROVIDER_SECURITY_LIVE_INTENTS_PER_SESSION; index++)
      live.push(await intent(owner.webActor));
    await expect(intent(owner.webActor)).rejects.toMatchObject({ outcome: 'denied', code: 'too_many_pending' });
    // Another session of the same account has its own slots.
    const other = await environment.secondSession(owner);
    await intent(other.webActor);
    await abortProviderSecurityMutation(environment.database, environment.runtime, {
      ...live[0].bound,
      preparationToken: null,
      flowHash: null,
    });
    await intent(owner.webActor);
    await expect(intent(owner.webActor)).rejects.toMatchObject({ code: 'too_many_pending' });
  });

  it('two tabs, one session: both prepare, the first finalizes, the second is refused and writes nothing', async () => {
    const owner = await environment.actor('better-auth', 'canonical-token');
    const firstTab = await preparedLink(owner.webActor);
    const secondTab = await preparedLink(owner.webActor);
    expect(
      await finalizeProviderSecurityMutation(environment.database, environment.runtime, {
        ...firstTab.bound,
        reauthenticationToken: firstTab.reauthenticationToken,
        preparationToken: firstTab.preparationToken,
      }),
    ).toEqual({ outcome: 'committed', generation: 1 });
    const before = await snapshot(secondTab.intentToken, [owner.userId]);
    await expect(
      finalizeProviderSecurityMutation(environment.database, environment.runtime, {
        ...secondTab.bound,
        reauthenticationToken: secondTab.reauthenticationToken,
        preparationToken: secondTab.preparationToken,
      }),
    ).rejects.toMatchObject({ outcome: 'identity_changed' });
    expect(await snapshot(secondTab.intentToken, [owner.userId])).toEqual(before);
    expect(await linked(owner.userId, firstTab.providerProof.subject)).toBe(true);
    expect(await linked(owner.userId, secondTab.providerProof.subject)).toBe(false);
    expect(before.cutoffs[0].generation).toBe(1);
  });
});
