import { describe, expect, it } from 'vitest';
import {
  browserBindingCursorSchema,
  browserCoordinatorCommandSchema,
  browserCoordinatorConnectSchema,
  browserCoordinatorReplySchema,
  compareBrowserBindingCursor,
  requireCoordinatorOrigin,
} from '../browser-coordinator-v1';
const cursor = { bindingId: 'a'.repeat(64), version: 2 };
const envelope = { protocolVersion: 1, connectionId: crypto.randomUUID(), requestId: crypto.randomUUID() };
describe('credential-free coordinator contract', () => {
  it.each(['login', 'replacement', 'logout'])('admits only cursor metadata for %s preparation', (transition) => {
    expect(browserCoordinatorCommandSchema.parse({ operation: 'prepare', transition, expectedCursor: cursor })).toEqual(
      { operation: 'prepare', transition, expectedCursor: cursor },
    );
  });
  it.each(['token', 'credential', 'password', 'userId', 'authSessionId', 'auth_time', 'intentToken'])(
    'refuses the credential/claim field %s',
    (field) => {
      expect(browserCoordinatorCommandSchema.safeParse({ operation: 'read', [field]: 'must-not-cross' }).success).toBe(
        false,
      );
      expect(
        browserCoordinatorCommandSchema.safeParse({
          operation: 'renew',
          expectedCursor: { ...cursor, [field]: 'must-not-cross' },
        }).success,
      ).toBe(false);
      expect(
        browserCoordinatorReplySchema.safeParse({
          ...envelope,
          type: 'result',
          operation: 'read',
          result: { status: 'ready', cursor, [field]: 'must-not-cross' },
        }).success,
      ).toBe(false);
    },
  );
  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])('refuses invalid version %s', (version) => {
    expect(browserBindingCursorSchema.safeParse({ ...cursor, version }).success).toBe(false);
  });
  it('requires digest/UUID metadata and a fixed operation schema', () => {
    expect(browserBindingCursorSchema.safeParse({ ...cursor, bindingId: 'raw-cookie' }).success).toBe(false);
    expect(
      browserCoordinatorConnectSchema.safeParse({ protocolVersion: 1, type: 'connect', connectionId: 'not-a-uuid' })
        .success,
    ).toBe(false);
    expect(
      browserCoordinatorCommandSchema.safeParse({ operation: 'fetch', url: 'https://attacker.test' }).success,
    ).toBe(false);
    expect(browserCoordinatorCommandSchema.safeParse({ operation: 'prepare', transition: 'logout' }).success).toBe(
      false,
    );
  });
  it('refuses an older/different binding reply without resetting the cursor', () => {
    expect(compareBrowserBindingCursor(null, cursor)).toBe('current');
    expect(compareBrowserBindingCursor(cursor, { ...cursor, version: 3 })).toBe('current');
    expect(compareBrowserBindingCursor(cursor, cursor)).toBe('current');
    expect(compareBrowserBindingCursor(cursor, { ...cursor, version: 1 })).toBe('stale');
    expect(compareBrowserBindingCursor(cursor, { bindingId: 'b'.repeat(64), version: 999 })).toBe('different-binding');
  });
  it.each([
    'http://www.boardsesh.test',
    'https://www.boardsesh.test/path',
    'https://user@www.boardsesh.test',
    'https://www.boardsesh.test?redirect=1',
    'https://www.boardsesh.test#fragment',
    'https://www.boardsesh.test/',
  ])('refuses noncanonical origin %s', (origin) => expect(() => requireCoordinatorOrigin(origin)).toThrow());
  it('accepts an exact configured HTTPS origin', () =>
    expect(requireCoordinatorOrigin('https://www.boardsesh.test:4443')).toBe('https://www.boardsesh.test:4443'));
});
