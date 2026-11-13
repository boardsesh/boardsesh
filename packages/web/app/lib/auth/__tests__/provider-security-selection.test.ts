// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { AUTH_BACKEND_UNAVAILABLE } from '@boardsesh/auth-protocol/client-errors';
vi.mock('server-only', () => ({}));
import {
  captureProviderBrowserContext,
  providerBindingHash,
  ProviderSecurityIdentityChangedError,
  requireProviderSecurityFlowActor,
  type ProviderAdmittedBrowserSelection,
} from '../provider-security-selection.server';
import type { ProviderSecurityFlow } from '../provider-security-flow.server';

const now = new Date('2026-11-13T12:00:00.000Z');
function selection(kind: 'canonical-token' | 'legacy-jwe' = 'canonical-token'): ProviderAdmittedBrowserSelection {
  const bindingToken = 'A'.repeat(43);
  return {
    status: 'admitted',
    bindingToken,
    actor: {
      version: 2,
      credential:
        kind === 'canonical-token' ? { kind, token: 'K'.repeat(43) } : { kind, credential: 'actual-admitted-jwe' },
    },
    cursor: { bindingId: providerBindingHash(bindingToken), version: 2, bindingExpiresAt: '2026-11-14T12:00:00.000Z' },
    session: {
      userId: 'owned-user',
      authSessionId: 'owned-session',
      generation: 3,
      authenticatedAt: '2026-08-01T00:00:00.000Z',
      expiresAt: '2026-11-13T13:00:00.000Z',
      linkGuarded: true,
      requiresAccountCutoff: true,
    },
    user: { id: 'owned-user', email: 'owned@example.invalid', name: null, image: null },
  };
}
function flow(context = captureProviderBrowserContext(selection(), now)): ProviderSecurityFlow {
  return {
    version: 1,
    action: 'link',
    provider: 'apple',
    methodId: null,
    actorKind: context.actor.kind,
    actorCredentialHash: context.credentialHash,
    browserBindingHash: context.browserCursor.bindingId,
    browserVersion: context.browserCursor.version,
    browserBindingExpiresAt: context.browserCursor.bindingExpiresAt,
    sourceCredentialProof: { ...context.sourceCredentialProof },
    credentialExpiresAt: context.credentialExpiresAt,
    intentToken: 'B'.repeat(43),
    browserIntentToken: 'C'.repeat(43),
    recoveryToken: 'D'.repeat(43),
    issuedAt: now.toISOString(),
    expiresAt: '2026-11-13T12:15:00.000Z',
    reauthenticationToken: null,
    reauthenticationExpiresAt: null,
    providerFlowHash: null,
    googleFlowHash: null,
    googleNonce: null,
  };
}

describe('provider context projection from the admitted central browser reader', () => {
  it.each(['canonical-token', 'legacy-jwe'] as const)(
    'captures actual %s source and retains signed original provenance',
    (kind) => {
      const input = selection(kind);
      const context = captureProviderBrowserContext(input, now);
      expect(context.actor).toMatchObject({
        kind,
        expectedUserId: 'owned-user',
        expectedAuthSessionId: 'owned-session',
        browserVersion: 2,
      });
      expect(context.actor.credential).toBe(kind === 'canonical-token' ? 'K'.repeat(43) : 'actual-admitted-jwe');
      expect(context.sourceCredentialProof).toMatchObject({
        generation: 3,
        authenticatedAt: '2026-08-01T00:00:00.000Z',
        requiresAccountCutoff: true,
      });
      expect(() => requireProviderSecurityFlowActor(flow(context), context)).not.toThrow();
      input.session.generation = 4;
      input.cursor.version = 3;
      expect(context.sourceCredentialProof.generation).toBe(3);
      expect(context.browserCursor.version).toBe(2);
      expect(Object.isFrozen(context.actor)).toBe(true);
    },
  );
  it('retains unknown original age and never promotes the observation clock', () => {
    const input = selection();
    input.session.authenticatedAt = null;
    input.session.linkGuarded = false;
    expect(captureProviderBrowserContext(input, now).sourceCredentialProof).toMatchObject({
      authenticatedAt: null,
      linkGuarded: false,
      requiresAccountCutoff: true,
    });
  });
  it.each([
    [
      'UID',
      (current: ProviderAdmittedBrowserSelection) => {
        current.session.userId = 'other-user';
        current.user.id = 'other-user';
      },
    ],
    [
      'SID',
      (current: ProviderAdmittedBrowserSelection) => {
        current.session.authSessionId = 'other-session';
      },
    ],
    [
      'generation',
      (current: ProviderAdmittedBrowserSelection) => {
        current.session.generation += 1;
      },
    ],
    [
      'version',
      (current: ProviderAdmittedBrowserSelection) => {
        current.actor.version += 1;
        current.cursor.version += 1;
      },
    ],
    [
      'actual bearer',
      (current: ProviderAdmittedBrowserSelection) => {
        current.actor.credential = { kind: 'canonical-token', token: 'L'.repeat(43) };
      },
    ],
    [
      'binding',
      (current: ProviderAdmittedBrowserSelection) => {
        const bindingToken = 'Z'.repeat(43);
        return {
          ...current,
          bindingToken,
          cursor: { ...current.cursor, bindingId: providerBindingHash(bindingToken) },
        };
      },
    ],
  ] as const)('changes UI actor scope and refuses an old flow after %s changes', (_label, change) => {
    const original = captureProviderBrowserContext(selection(), now);
    const current = selection();
    const changed = change(current) ?? current;
    const context = captureProviderBrowserContext(changed, now);
    expect(context.actorContextKey).not.toBe(original.actorContextKey);
    expect(() => requireProviderSecurityFlowActor(flow(original), context)).toThrow(
      ProviderSecurityIdentityChangedError,
    );
  });
  it.each([
    [
      'age',
      (current: ProviderAdmittedBrowserSelection) => {
        current.session.authenticatedAt = '2026-09-01T00:00:00.000Z';
      },
    ],
    [
      'source expiry',
      (current: ProviderAdmittedBrowserSelection) => {
        current.session.expiresAt = '2026-11-13T12:59:59.000Z';
      },
    ],
    [
      'binding expiry',
      (current: ProviderAdmittedBrowserSelection) => {
        current.cursor.bindingExpiresAt = '2026-11-14T11:59:59.000Z';
      },
    ],
    [
      'guard provenance',
      (current: ProviderAdmittedBrowserSelection) => {
        current.session.linkGuarded = false;
      },
    ],
    [
      'ancestry',
      (current: ProviderAdmittedBrowserSelection) => {
        current.session.requiresAccountCutoff = false;
      },
    ],
  ] as const)('refuses silently changed %s while preserving the original flow', (_label, change) => {
    const original = flow();
    const current = selection();
    change(current);
    expect(() => requireProviderSecurityFlowActor(original, captureProviderBrowserContext(current, now))).toThrow(
      ProviderSecurityIdentityChangedError,
    );
    expect(original.sourceCredentialProof.authenticatedAt).toBe('2026-08-01T00:00:00.000Z');
  });
  it.each([
    [
      'expired source',
      (current: ProviderAdmittedBrowserSelection) => {
        current.session.expiresAt = now.toISOString();
      },
    ],
    [
      'invalid source deadline',
      (current: ProviderAdmittedBrowserSelection) => {
        current.session.expiresAt = 'invalid';
      },
    ],
    [
      'expired binding',
      (current: ProviderAdmittedBrowserSelection) => {
        current.cursor.bindingExpiresAt = now.toISOString();
      },
    ],
    [
      'invented current proof',
      (current: ProviderAdmittedBrowserSelection) => {
        current.session.authenticatedAt = '2026-11-13T12:00:00.001Z';
      },
    ],
    [
      'guarded unknown age',
      (current: ProviderAdmittedBrowserSelection) => {
        current.session.authenticatedAt = null;
      },
    ],
    [
      'cursor drift',
      (current: ProviderAdmittedBrowserSelection) => {
        current.cursor.version += 1;
      },
    ],
    [
      'binding alias',
      (current: ProviderAdmittedBrowserSelection) => {
        current.cursor.bindingId = 'f'.repeat(64);
      },
    ],
    [
      'wrong user projection',
      (current: ProviderAdmittedBrowserSelection) => {
        current.user.id = 'other-user';
      },
    ],
    [
      'exhausted version',
      (current: ProviderAdmittedBrowserSelection) => {
        current.actor.version = 2_147_483_647;
        current.cursor.version = 2_147_483_647;
      },
    ],
  ] as const)('fails closed on %s before emitting a command actor', (_label, change) => {
    const input = selection();
    change(input);
    expect(() => captureProviderBrowserContext(input, now)).toThrow(AUTH_BACKEND_UNAVAILABLE);
  });
});
