import { expect, it } from 'vite-plus/test';
import { firstPasswordCommandSchema } from '../first-password-v1';
import { providerSecurityCommandSchema } from '../provider-security-v1';

// #7596 B5d: the browser binding is gone. No subpath exports its protocol, and
// no command accepts a binding field: each case below is a valid command with
// only binding fields added, so the binding field is what gets it refused.
const requestId = 'dbdf354c-33de-4f01-9c88-12bc1afde697';
const issuedAt = '2026-11-18T12:00:00.000Z';
const token = 'A'.repeat(43);
const actor = {
  presented: { kind: 'canonical-token', token: 'raw-session-token' },
  expectedUserId: 'owner',
  expectedAuthSessionId: 'session',
};
const bindingActorFields = { browserBindingToken: token, browserVersion: 3 };
const providerSecurity = (operation: string, payload: Record<string, unknown>) =>
  providerSecurityCommandSchema.safeParse({ providerSecurityVersion: 1, requestId, issuedAt, operation, payload })
    .success;
const firstPassword = (operation: string, payload: Record<string, unknown>) =>
  firstPasswordCommandSchema.safeParse({ firstPasswordVersion: 1, requestId, issuedAt, operation, payload }).success;

it('exports no browser-binding protocol subpath', async () => {
  const retired = '@boardsesh/auth-protocol/browser-binding-v1';
  await expect(import(/* @vite-ignore */ retired)).rejects.toThrow();
});

it('provider security accepts the web-session command and refuses it with any binding field', () => {
  const intent = { actor, action: 'link', provider: 'google', methodId: null };
  const bind = { actor, intentToken: token, flowHash: 'f'.repeat(64) };
  // Positive controls: the same commands without binding fields.
  expect(providerSecurity('intent', intent)).toBe(true);
  expect(providerSecurity('bind', bind)).toBe(true);
  expect(providerSecurity('intent', { ...intent, actor: { ...actor, ...bindingActorFields } })).toBe(false);
  expect(providerSecurity('bind', { ...bind, browserIntentToken: token })).toBe(false);
  // The binding sign-in operations are gone even with a well-formed web-session payload.
  for (const operation of ['signin-intent', 'signin-prepare', 'signin-finalize', 'signin-abort'])
    expect(providerSecurity(operation, intent)).toBe(false);
});

it('first password accepts the web-session command and refuses it with any binding field', () => {
  const read = { actor, challengeToken: token };
  expect(firstPassword('read', read)).toBe(true);
  expect(firstPassword('request', { actor })).toBe(true);
  expect(firstPassword('read', { ...read, browserIntentToken: token })).toBe(false);
  expect(firstPassword('request', { actor: { ...actor, ...bindingActorFields } })).toBe(false);
});
