import { describe, expect, it } from 'vite-plus/test';
import {
  decideConsolidationSessionTransfer,
  type ConsolidationTransferState,
  type VerifiedConsolidationProof,
} from '../decision';
import { exchangeConsolidationSession, type ConsolidationExchangeTransaction } from '../exchange';

const NOW = 10000;
function state(): ConsolidationTransferState {
  return {
    retirement: {
      mergeId: 'merge',
      sourceUserId: 'source',
      targetUserId: 'target',
      retiredAtMs: 5000,
      sourceGenerationBefore: 2,
      sourceNativeGenerationBefore: 3,
      sourceGenerationAfter: 3,
      sourceNativeGenerationAfter: 3,
      targetGeneration: 7,
      targetNativeGeneration: 8,
    },
    source: { userId: 'source', active: false, generation: 3, nativeGeneration: 3, consolidationMergeId: 'merge' },
    target: { userId: 'target', active: true, generation: 7, nativeGeneration: 8, consolidationMergeId: null },
    bridgeRevoked: false,
  };
}
function proof(): VerifiedConsolidationProof {
  return {
    kind: 'native-refresh',
    userId: 'source',
    credentialId: 'refresh-row',
    issuedAtMs: 1000,
    expiresAtMs: 20000,
    authenticatedAtMs: 500,
    sourceGeneration: 2,
    sourceNativeGeneration: 3,
    revoked: false,
    sessionId: 'old-session',
  };
}

describe('consolidation credential eligibility', () => {
  it('keeps original age, expiry and lineage while using target stamps', () => {
    expect(decideConsolidationSessionTransfer(proof(), state(), NOW)).toMatchObject({
      allowed: true,
      authenticatedAtMs: 500,
      originalExpiresAtMs: 20000,
      originalSessionId: 'old-session',
      targetGeneration: 7,
      targetNativeGeneration: 8,
    });
  });
  it('never upgrades unknown authentication age', () => {
    expect(decideConsolidationSessionTransfer({ ...proof(), authenticatedAtMs: null }, state(), NOW)).toMatchObject({
      allowed: true,
      authenticatedAtMs: null,
    });
  });
  it.each(['source', 'target'] as const)('refuses %s generation drift', (subject) => {
    const changed = state();
    expect(
      decideConsolidationSessionTransfer(
        proof(),
        { ...changed, [subject]: { ...changed[subject], generation: changed[subject].generation + 1 } },
        NOW,
      ),
    ).toMatchObject({ allowed: false, reason: 'generation' });
  });
  it('refuses native target sign-out without affecting the separate web domain', () => {
    const changed = state();
    const signedOut = { ...changed, target: { ...changed.target, nativeGeneration: 9 } };
    expect(decideConsolidationSessionTransfer(proof(), signedOut, NOW)).toMatchObject({ allowed: false });
    const web: VerifiedConsolidationProof = {
      ...proof(),
      kind: 'web-session',
      sessionId: 'sid',
      revocationLineageVerified: true,
    };
    expect(decideConsolidationSessionTransfer(web, signedOut, NOW)).toMatchObject({ allowed: true });
  });
  it('refuses explicit revocation even without generation movement', () => {
    expect(decideConsolidationSessionTransfer(proof(), { ...state(), bridgeRevoked: true }, NOW)).toEqual({
      allowed: false,
      reason: 'revoked',
    });
    expect(decideConsolidationSessionTransfer({ ...proof(), revoked: true }, state(), NOW)).toEqual({
      allowed: false,
      reason: 'revoked',
    });
  });
  it('checks the original deadline including exact expiry', () => {
    expect(decideConsolidationSessionTransfer({ ...proof(), expiresAtMs: NOW }, state(), NOW)).toEqual({
      allowed: false,
      reason: 'expired',
    });
  });
  it('does not transfer an active or differently retired source or a retired target', () => {
    const changed = state();
    for (const source of [
      { ...changed.source, active: true },
      { ...changed.source, consolidationMergeId: 'other' },
    ])
      expect(decideConsolidationSessionTransfer(proof(), { ...changed, source }, NOW)).toMatchObject({
        allowed: false,
      });
    expect(
      decideConsolidationSessionTransfer(proof(), { ...changed, target: { ...changed.target, active: false } }, NOW),
    ).toMatchObject({ allowed: false });
  });
  it('requires pre-cutover issuance and never accepts future authentication proof', () => {
    expect(decideConsolidationSessionTransfer({ ...proof(), issuedAtMs: 6000 }, state(), NOW)).toMatchObject({
      allowed: false,
    });
    expect(decideConsolidationSessionTransfer({ ...proof(), authenticatedAtMs: 2000 }, state(), NOW)).toMatchObject({
      allowed: false,
    });
  });
  it('requires a stable verified web revocation lineage', () => {
    const web: VerifiedConsolidationProof = {
      ...proof(),
      kind: 'web-session',
      sessionId: 'sid',
      revocationLineageVerified: true,
    };
    expect(decideConsolidationSessionTransfer(web, state(), NOW)).toMatchObject({ allowed: true });
    expect(decideConsolidationSessionTransfer({ ...web, revocationLineageVerified: false }, state(), NOW)).toEqual({
      allowed: false,
      reason: 'unknown-web-lineage',
    });
    expect(decideConsolidationSessionTransfer({ ...web, sessionId: '' }, state(), NOW)).toMatchObject({
      allowed: false,
    });
  });
  it('rejects malformed stamps and unrelated credential owners', () => {
    expect(decideConsolidationSessionTransfer({ ...proof(), sourceGeneration: NaN }, state(), NOW)).toMatchObject({
      allowed: false,
    });
    expect(decideConsolidationSessionTransfer({ ...proof(), userId: 'outsider' }, state(), NOW)).toEqual({
      allowed: false,
      reason: 'wrong-owner',
    });
  });
});

describe('transaction-scoped bridge orchestration', () => {
  it('locks sorted subjects before re-reading proof and checks time after waits', async () => {
    const steps: string[] = [];
    const transaction: ConsolidationExchangeTransaction<string> = {
      async lockSubjectsInOrder(ids) {
        expect(ids).toEqual(['source', 'target']);
        steps.push('locks');
      },
      async readLockedTransfer() {
        steps.push('read');
        return { proof: proof(), state: state() };
      },
      async consumeOnce() {
        steps.push('consume');
        return true;
      },
      async issueCanonical() {
        steps.push('issue');
        return 'issued';
      },
    };
    const hint = { credentialId: 'refresh-row', sourceUserId: 'source', targetUserId: 'target' };
    await expect(
      exchangeConsolidationSession(transaction, hint, () => {
        steps.push('clock');
        return NOW;
      }),
    ).resolves.toBe('issued');
    expect(steps).toEqual(['locks', 'read', 'clock', 'consume', 'issue']);
    await expect(exchangeConsolidationSession(transaction, hint, () => 20000)).rejects.toMatchObject({
      code: 'INELIGIBLE',
    });
  });
  it('never issues another lineage after one-use consumption fails', async () => {
    let issued = 0;
    const transaction: ConsolidationExchangeTransaction<string> = {
      async lockSubjectsInOrder() {},
      async readLockedTransfer() {
        return { proof: proof(), state: state() };
      },
      async consumeOnce() {
        return false;
      },
      async issueCanonical() {
        issued++;
        return 'issued';
      },
    };
    await expect(
      exchangeConsolidationSession(
        transaction,
        { credentialId: 'refresh-row', sourceUserId: 'source', targetUserId: 'target' },
        () => NOW,
      ),
    ).rejects.toMatchObject({ code: 'CONSUMED' });
    expect(issued).toBe(0);
  });
});
