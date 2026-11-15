import { describe, expect, it } from 'vite-plus/test';
import {
  BROWSER_PASSWORD_BROWSER_PATHS,
  browserPasswordBrowserControlSchema,
  browserPasswordBrowserPrepareMetadataSchema,
  browserPasswordBrowserRecoverySchema,
  browserPasswordBrowserReplySchema,
} from '../browser-password-browser-v1';

const cursor = { bindingId: 'a'.repeat(64), version: 7 };
const operationKey = 'b'.repeat(64);
describe('canonical password public control metadata', () => {
  it('has four exact canonical POST paths', () => {
    expect(Object.values(BROWSER_PASSWORD_BROWSER_PATHS)).toEqual(
      ['prepare', 'commit', 'confirm', 'acknowledge'].map(
        (operation) => `/api/internal/auth/browser-password/${operation}`,
      ),
    );
  });
  it('carries only a pinned public cursor before installed form preparation', () => {
    expect(browserPasswordBrowserPrepareMetadataSchema.parse({ cursor })).toEqual({ cursor });
    expect(
      browserPasswordBrowserPrepareMetadataSchema.safeParse({
        cursor: { ...cursor, bindingExpiresAt: '2026-12-01T00:00:00Z' },
      }).success,
    ).toBe(false);
  });
  it.each([
    'password',
    'email',
    'candidate',
    'operationToken',
    'browserIntentToken',
    'preparation',
    'credentialKind',
    'userId',
    'source',
  ])('does not transport %s through control metadata', (field) => {
    expect(browserPasswordBrowserPrepareMetadataSchema.safeParse({ cursor, [field]: 'private' }).success).toBe(false);
    expect(browserPasswordBrowserControlSchema.safeParse({ operationKey, cursor, [field]: 'private' }).success).toBe(
      false,
    );
    expect(
      browserPasswordBrowserRecoverySchema.safeParse({ purpose: 'password-signin-recovery', [field]: 'private' })
        .success,
    ).toBe(false);
  });
  it('correlates prepared public source and target versions', () => {
    const prepared = {
      status: 'prepared',
      operationKey,
      sourceCursor: cursor,
      targetCursor: { ...cursor, version: 8 },
    };
    expect(browserPasswordBrowserReplySchema.parse(prepared)).toEqual(prepared);
    expect(browserPasswordBrowserReplySchema.safeParse({ ...prepared, targetCursor: cursor }).success).toBe(false);
    expect(
      browserPasswordBrowserReplySchema.safeParse({
        ...prepared,
        targetCursor: { bindingId: 'c'.repeat(64), version: 8 },
      }).success,
    ).toBe(false);
  });
  it('recovery names no uncompleted operation or asserted identity', () => {
    expect(browserPasswordBrowserRecoverySchema.parse({ purpose: 'password-signin-recovery' })).toEqual({
      purpose: 'password-signin-recovery',
    });
    expect(
      browserPasswordBrowserRecoverySchema.safeParse({ purpose: 'password-signin-recovery', operationKey }).success,
    ).toBe(false);
  });
  it.each(['http://www.boardsesh.test/', 'https://user@www.boardsesh.test/', 'https://www.boardsesh.test/#fragment'])(
    'refuses an unsafe completed destination %s',
    (url) => {
      expect(
        browserPasswordBrowserReplySchema.safeParse({ status: 'confirmed', operationKey, cursor, url }).success,
      ).toBe(false);
    },
  );
});
