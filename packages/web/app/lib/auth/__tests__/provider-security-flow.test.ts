// @vitest-environment node
import { createCipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { AUTH_BACKEND_UNAVAILABLE } from '@boardsesh/auth-protocol/client-errors';
vi.mock('server-only', () => ({}));
import {
  openProviderSecurityFlow,
  providerSecurityFlowCookieName,
  providerSecurityOperationKey,
  sealProviderSecurityFlow,
  type ProviderSecurityFlow,
} from '../provider-security-flow.server';

const secret = 'owned-provider-operation-flow-secret-6975';
const now = new Date('2026-11-13T10:00:00.000Z');
function frame(): ProviderSecurityFlow {
  return {
    version: 1,
    action: 'link',
    provider: 'apple',
    methodId: null,
    actorKind: 'canonical-token',
    actorCredentialHash: 'a'.repeat(64),
    browserBindingHash: 'b'.repeat(64),
    browserVersion: 2,
    browserBindingExpiresAt: '2026-11-14T10:00:00.000Z',
    sourceCredentialProof: {
      version: 1,
      userId: 'owned-user',
      authSessionId: 'owned-session',
      generation: 3,
      authenticatedAt: '2026-11-12T10:00:00.000Z',
      linkGuarded: true,
      requiresAccountCutoff: true,
    },
    credentialExpiresAt: '2026-11-13T11:00:00.000Z',
    intentToken: 'A'.repeat(43),
    browserIntentToken: 'B'.repeat(43),
    recoveryToken: 'C'.repeat(43),
    issuedAt: now.toISOString(),
    expiresAt: '2026-11-13T10:15:00.000Z',
    reauthenticationToken: null,
    reauthenticationExpiresAt: null,
    providerFlowHash: null,
    googleFlowHash: null,
    googleNonce: null,
  };
}
const operationKey = providerSecurityOperationKey(frame().intentToken);
async function trustedMalformed(payload: Record<string, unknown>, purpose = 'boardsesh-provider-security-flow-v1') {
  const key = Buffer.from(hkdfSync('sha256', secret, purpose, 'boardsesh-web-operation-cookie', 32));
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(purpose));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return [
    'v1',
    nonce.toString('base64url'),
    ciphertext.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
  ].join('.');
}

describe('purpose-bound provider operation flow cookies', () => {
  it('roundtrips only command capabilities and preserves the original source age and marker', async () => {
    const input = frame();
    const sealed = await sealProviderSecurityFlow(input, secret, now);
    expect(sealed).not.toContain(input.intentToken);
    const opened = await openProviderSecurityFlow(sealed, operationKey, secret, now);
    expect(opened).toEqual(input);
    expect(Object.isFrozen(opened)).toBe(true);
    expect(Object.isFrozen(opened.sourceCredentialProof)).toBe(true);
    expect(providerSecurityFlowCookieName(operationKey, true)).toBe(
      `__Host-boardsesh.provider-security.${operationKey}`,
    );
    expect(providerSecurityFlowCookieName(operationKey, false)).toBe(`boardsesh.provider-security.${operationKey}`);
  });
  it('captures caller-owned nested proof before encryption awaits', async () => {
    const input = frame();
    const pending = sealProviderSecurityFlow(input, secret, now);
    input.sourceCredentialProof.userId = 'other-user';
    expect(
      (await openProviderSecurityFlow(await pending, operationKey, secret, now)).sourceCredentialProof.userId,
    ).toBe('owned-user');
  });
  it('captures the trusted reader clock before decryption awaits', async () => {
    const sealed = await sealProviderSecurityFlow(frame(), secret, now);
    const clock = new Date(now);
    const pending = openProviderSecurityFlow(sealed, operationKey, secret, clock);
    clock.setUTCFullYear(2027);
    expect((await pending).issuedAt).toBe(now.toISOString());
  });
  it('retains unknown original age without inventing an authentication event', async () => {
    const input = frame();
    input.sourceCredentialProof.authenticatedAt = null;
    input.sourceCredentialProof.linkGuarded = false;
    expect(
      (await openProviderSecurityFlow(await sealProviderSecurityFlow(input, secret, now), operationKey, secret, now))
        .sourceCredentialProof.authenticatedAt,
    ).toBeNull();
  });
  it.each([
    ['wrong operation', 'd'.repeat(64), secret, now],
    ['wrong reader key', operationKey, `${secret}-other`, now],
    ['expired command', operationKey, secret, new Date('2026-11-13T10:15:00.000Z')],
    ['invalid reader clock', operationKey, secret, new Date(Number.NaN)],
  ] as const)('refuses %s without exposing capabilities', async (_label, selector, readerKey, clock) => {
    const sealed = await sealProviderSecurityFlow(frame(), secret, now);
    await expect(openProviderSecurityFlow(sealed, selector, readerKey, clock)).rejects.toThrow(
      AUTH_BACKEND_UNAVAILABLE,
    );
  });
  it('rejects tampering and ciphertext from another purpose', async () => {
    const sealed = await sealProviderSecurityFlow(frame(), secret, now);
    const parts = sealed.split('.');
    parts[3] = `${parts[3][0] === 'a' ? 'b' : 'a'}${parts[3].slice(1)}`;
    await expect(openProviderSecurityFlow(parts.join('.'), operationKey, secret, now)).rejects.toThrow(
      AUTH_BACKEND_UNAVAILABLE,
    );
    const foreign = await trustedMalformed({ flow: frame() }, 'boardsesh-other-purpose-v1');
    await expect(openProviderSecurityFlow(foreign, operationKey, secret, now)).rejects.toThrow(
      AUTH_BACKEND_UNAVAILABLE,
    );
  });
  it.each([
    ['future issue time', { issuedAt: '2026-11-13T10:01:00.000Z' }],
    ['expired source', { credentialExpiresAt: '2026-11-13T09:59:59.000Z' }],
    ['shorter binding', { browserBindingExpiresAt: '2026-11-13T10:01:00.000Z' }],
    ['extended command', { expiresAt: '2026-11-13T10:15:00.001Z' }],
    ['unpaired proof', { reauthenticationToken: 'D'.repeat(43) }],
    ['expired proof', { reauthenticationToken: 'D'.repeat(43), reauthenticationExpiresAt: now.toISOString() }],
    [
      'proof beyond operation',
      { reauthenticationToken: 'D'.repeat(43), reauthenticationExpiresAt: '2026-11-13T10:16:00.000Z' },
    ],
    ['unbound Google nonce', { googleNonce: 'owned-nonce' }],
    ['raw actor bearer', { credential: 'must-never-be-retained' }],
    ['raw proposed bearer', { candidate: 'must-never-be-retained' }],
    ['Facebook target', { provider: 'facebook' }],
  ])('refuses %s before sealing', async (_label, changes) => {
    await expect(sealProviderSecurityFlow({ ...frame(), ...changes }, secret, now)).rejects.toThrow(
      AUTH_BACKEND_UNAVAILABLE,
    );
  });
  it('refuses a future source authentication clock, guarded unknown age and cookie overflow', async () => {
    for (const sourceCredentialProof of [
      { ...frame().sourceCredentialProof, authenticatedAt: '2026-11-13T10:00:01.000Z' },
      { ...frame().sourceCredentialProof, authenticatedAt: null, linkGuarded: true },
      { ...frame().sourceCredentialProof, userId: 'u'.repeat(1024), authSessionId: 's'.repeat(1024) },
    ])
      await expect(sealProviderSecurityFlow({ ...frame(), sourceCredentialProof }, secret, now)).rejects.toThrow(
        AUTH_BACKEND_UNAVAILABLE,
      );
  });
  it('independently validates actual encrypted frame clocks and rejects extra fields', async () => {
    const input = frame();
    for (const payload of [
      { flow: { ...input, issuedAt: '2026-11-13T10:00:01.000Z' } },
      { flow: { ...input, expiresAt: '2026-11-13T10:15:00.001Z' } },
      { flow: input, candidate: 'never-return-this' },
    ])
      await expect(
        openProviderSecurityFlow(await trustedMalformed(payload), operationKey, secret, now),
      ).rejects.toThrow(AUTH_BACKEND_UNAVAILABLE);
  });
});
