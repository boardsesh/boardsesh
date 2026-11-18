import { expect, it } from 'vite-plus/test';
import { firstPasswordCommandSchema } from '../first-password-v1';
import { providerSecurityCommandSchema } from '../provider-security-v1';

// #7596 B5d: the browser binding is gone. No subpath exports its protocol, and
// no command accepts a binding actor, a browser intent token or a cursor.
const metadata = { requestId: 'dbdf354c-33de-4f01-9c88-12bc1afde697', issuedAt: '2026-11-18T12:00:00.000Z' };
const bindingActor = {
  kind: 'canonical-token',
  credential: 'raw-session-token',
  expectedUserId: 'owner',
  expectedAuthSessionId: 'session',
  browserBindingToken: 'A'.repeat(43),
  browserVersion: 3,
};

it('exports no browser-binding protocol subpath', async () => {
  const retired = '@boardsesh/auth-protocol/browser-binding-v1';
  await expect(import(/* @vite-ignore */ retired)).rejects.toThrow();
});

it.each(['methods', 'intent', 'signin-intent', 'signin-prepare', 'signin-finalize', 'signin-abort'])(
  'provider security refuses a binding actor for %s',
  (operation) => {
    expect(
      providerSecurityCommandSchema.safeParse({
        ...metadata,
        providerSecurityVersion: 1,
        operation,
        payload: { actor: bindingActor, action: 'link', provider: 'google', methodId: null },
      }).success,
    ).toBe(false);
  },
);

it.each(['request', 'read'])('first password refuses a binding actor and a browser intent for %s', (operation) => {
  expect(
    firstPasswordCommandSchema.safeParse({
      ...metadata,
      firstPasswordVersion: 1,
      operation,
      payload: { actor: bindingActor, challengeToken: 'C'.repeat(43), browserIntentToken: 'D'.repeat(43) },
    }).success,
  ).toBe(false);
});
