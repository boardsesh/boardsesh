import { describe, expect, it } from 'vitest';
import {
  MAX_DEVICE_TOKEN_ACCOUNTS,
  chooseDeviceTokenForEmail,
  forgetDeviceTokenAccount,
  isUsableDeviceToken,
  mergeDeviceTokenReply,
  normaliseAccountEmail,
  parseDeviceTokenLedger,
  readDeviceTokenFromReply,
  serializeDeviceTokenLedger,
  setDeviceTokenAccountEmail,
  type DeviceTokenLedger,
} from '../device-token-ledger';

const tokenFor = (label: string) => `v1.${label.padEnd(22, 'x')}.1763424000.${'s'.repeat(43)}`;

describe('readDeviceTokenFromReply', () => {
  it('reads nothing from a reply without the field (backends before #7772, or the secret unset)', () => {
    expect(readDeviceTokenFromReply({ jwt: 'j', refreshToken: 'r', expiresAt: 'e', userId: 'user-1' })).toBeNull();
    expect(readDeviceTokenFromReply(null)).toBeNull();
    expect(readDeviceTokenFromReply('not an object')).toBeNull();
    expect(readDeviceTokenFromReply([{ deviceToken: tokenFor('a'), userId: 'user-1' }])).toBeNull();
  });

  it('pairs the token with the reply user id, falling back to the JWT subject', () => {
    expect(readDeviceTokenFromReply({ deviceToken: tokenFor('a'), userId: 'user-1' }, () => 'jwt-user')).toEqual({
      userId: 'user-1',
      token: tokenFor('a'),
    });
    expect(readDeviceTokenFromReply({ deviceToken: tokenFor('a') }, () => 'jwt-user')).toEqual({
      userId: 'jwt-user',
      token: tokenFor('a'),
    });
    expect(readDeviceTokenFromReply({ deviceToken: tokenFor('a') })).toBeNull();
  });

  it('only asks for the JWT subject when a token arrived without a user id', () => {
    let decoded = 0;
    const fallback = () => {
      decoded += 1;
      return 'jwt-user';
    };
    readDeviceTokenFromReply({ jwt: 'j', userId: 'user-1' }, fallback);
    readDeviceTokenFromReply({ deviceToken: tokenFor('a'), userId: 'user-1' }, fallback);
    expect(decoded).toBe(0);
    readDeviceTokenFromReply({ deviceToken: tokenFor('a') }, fallback);
    expect(decoded).toBe(1);
  });

  it('refuses a token that could not ride in a header', () => {
    for (const deviceToken of ['', 'has space', 'line\nbreak', 'x'.repeat(129), 42, { token: 'a' }]) {
      expect(readDeviceTokenFromReply({ deviceToken, userId: 'user-1' })).toBeNull();
    }
    expect(isUsableDeviceToken('x'.repeat(128))).toBe(true);
  });
});

describe('mergeDeviceTokenReply', () => {
  it('stores a new account at the front with its normalised email', () => {
    const ledger = mergeDeviceTokenReply([], {
      userId: 'user-1',
      token: tokenFor('a'),
      email: '  Climber@Example.COM ',
    });
    expect(ledger).toEqual([{ userId: 'user-1', email: 'climber@example.com', token: tokenFor('a') }]);
  });

  it('replaces the token on a refresh and keeps the email it had', () => {
    const signedIn = mergeDeviceTokenReply([], { userId: 'user-1', token: tokenFor('a'), email: 'a@example.com' });
    const refreshed = mergeDeviceTokenReply(signedIn, { userId: 'user-1', token: tokenFor('b') });
    expect(refreshed).toEqual([{ userId: 'user-1', email: 'a@example.com', token: tokenFor('b') }]);
  });

  it('keeps one entry per account and moves the latest to the front', () => {
    let ledger: DeviceTokenLedger = [];
    ledger = mergeDeviceTokenReply(ledger, { userId: 'user-1', token: tokenFor('a'), email: 'a@example.com' });
    ledger = mergeDeviceTokenReply(ledger, { userId: 'user-2', token: tokenFor('b'), email: 'b@example.com' });
    ledger = mergeDeviceTokenReply(ledger, { userId: 'user-1', token: tokenFor('c') });
    expect(ledger.map((account) => account.userId)).toEqual(['user-1', 'user-2']);
    expect(ledger[0].token).toBe(tokenFor('c'));
  });

  it(`keeps at most ${MAX_DEVICE_TOKEN_ACCOUNTS} accounts, dropping the least recently used`, () => {
    let ledger: DeviceTokenLedger = [];
    for (let index = 1; index <= MAX_DEVICE_TOKEN_ACCOUNTS + 2; index += 1) {
      ledger = mergeDeviceTokenReply(ledger, {
        userId: `user-${index}`,
        token: tokenFor(`t${index}`),
        email: `climber${index}@example.com`,
      });
    }
    expect(ledger).toHaveLength(MAX_DEVICE_TOKEN_ACCOUNTS);
    expect(ledger.map((account) => account.userId)).toEqual(['user-7', 'user-6', 'user-5', 'user-4', 'user-3']);
    expect(chooseDeviceTokenForEmail(ledger, 'climber1@example.com')).toBeNull();
  });

  it('gives an email to one account only', () => {
    let ledger = mergeDeviceTokenReply([], { userId: 'old', token: tokenFor('a'), email: 'shared@example.com' });
    ledger = mergeDeviceTokenReply(ledger, { userId: 'new', token: tokenFor('b'), email: 'Shared@example.com' });
    expect(ledger).toEqual([
      { userId: 'new', email: 'shared@example.com', token: tokenFor('b') },
      { userId: 'old', email: null, token: tokenFor('a') },
    ]);
  });
});

describe('chooseDeviceTokenForEmail', () => {
  const ledger = mergeDeviceTokenReply(
    mergeDeviceTokenReply([], { userId: 'user-1', token: tokenFor('a'), email: 'a@example.com' }),
    { userId: 'user-2', token: tokenFor('b') },
  );

  it('picks the token of the account signed in to with that email, ignoring case and spaces', () => {
    expect(chooseDeviceTokenForEmail(ledger, ' A@Example.com')).toBe(tokenFor('a'));
  });

  it('picks nothing for another email, a blank email, or an account whose email is unknown', () => {
    expect(chooseDeviceTokenForEmail(ledger, 'b@example.com')).toBeNull();
    expect(chooseDeviceTokenForEmail(ledger, '   ')).toBeNull();
    expect(chooseDeviceTokenForEmail([], 'a@example.com')).toBeNull();
  });
});

describe('setDeviceTokenAccountEmail', () => {
  it('fills the email of an entry a refresh reply created', () => {
    const ledger = mergeDeviceTokenReply([], { userId: 'user-1', token: tokenFor('a') });
    const next = setDeviceTokenAccountEmail(ledger, 'user-1', ' Climber@Example.com');
    expect(next).toEqual([{ userId: 'user-1', email: 'climber@example.com', token: tokenFor('a') }]);
    expect(chooseDeviceTokenForEmail(next, 'climber@example.com')).toBe(tokenFor('a'));
  });

  it('adds nothing for an account without a token, and returns the same ledger when nothing changes', () => {
    const ledger = mergeDeviceTokenReply([], { userId: 'user-1', token: tokenFor('a'), email: 'a@example.com' });
    expect(setDeviceTokenAccountEmail(ledger, 'user-2', 'b@example.com')).toBe(ledger);
    expect(setDeviceTokenAccountEmail(ledger, 'user-1', 'A@example.com')).toBe(ledger);
    expect(setDeviceTokenAccountEmail(ledger, 'user-1', '   ')).toBe(ledger);
  });

  it('moves the email off another account and follows an email change', () => {
    let ledger = mergeDeviceTokenReply([], { userId: 'old', token: tokenFor('a'), email: 'shared@example.com' });
    ledger = mergeDeviceTokenReply(ledger, { userId: 'new', token: tokenFor('b') });
    ledger = setDeviceTokenAccountEmail(ledger, 'new', 'shared@example.com');
    expect(ledger).toEqual([
      { userId: 'new', email: 'shared@example.com', token: tokenFor('b') },
      { userId: 'old', email: null, token: tokenFor('a') },
    ]);
    ledger = setDeviceTokenAccountEmail(ledger, 'new', 'renamed@example.com');
    expect(chooseDeviceTokenForEmail(ledger, 'renamed@example.com')).toBe(tokenFor('b'));
    expect(chooseDeviceTokenForEmail(ledger, 'shared@example.com')).toBeNull();
  });
});

describe('forgetDeviceTokenAccount', () => {
  it('drops only that account', () => {
    const ledger = mergeDeviceTokenReply(
      mergeDeviceTokenReply([], { userId: 'user-1', token: tokenFor('a'), email: 'a@example.com' }),
      { userId: 'user-2', token: tokenFor('b'), email: 'b@example.com' },
    );
    expect(forgetDeviceTokenAccount(ledger, 'user-1')).toEqual([
      { userId: 'user-2', email: 'b@example.com', token: tokenFor('b') },
    ]);
    expect(forgetDeviceTokenAccount(ledger, 'nobody')).toEqual(ledger);
  });
});

describe('parseDeviceTokenLedger', () => {
  it('round-trips a serialized ledger', () => {
    const ledger = mergeDeviceTokenReply([], { userId: 'user-1', token: tokenFor('a'), email: 'a@example.com' });
    expect(parseDeviceTokenLedger(serializeDeviceTokenLedger(ledger))).toEqual(ledger);
  });

  it('drops a malformed value instead of throwing', () => {
    for (const stored of [
      null,
      '',
      'not json',
      '[]',
      'null',
      '{"v":2,"accounts":[]}',
      '{"v":1,"accounts":{}}',
      '{"v":1}',
    ]) {
      expect(parseDeviceTokenLedger(stored)).toEqual([]);
    }
  });

  it('skips malformed and duplicate entries but keeps the good ones, bounded', () => {
    const stored = JSON.stringify({
      v: 1,
      accounts: [
        null,
        { userId: 'user-1', email: 'A@example.com', token: tokenFor('a') },
        { userId: 'user-1', email: 'dup@example.com', token: tokenFor('dup') },
        { userId: '', token: tokenFor('b') },
        { userId: 'user-3', token: 'bad token' },
        { userId: 'user-4', email: 7, token: tokenFor('d') },
        ...Array.from({ length: 10 }, (_, index) => ({ userId: `extra-${index}`, email: null, token: tokenFor('e') })),
      ],
    });
    const ledger = parseDeviceTokenLedger(stored);
    expect(ledger).toHaveLength(MAX_DEVICE_TOKEN_ACCOUNTS);
    expect(ledger[0]).toEqual({ userId: 'user-1', email: 'a@example.com', token: tokenFor('a') });
    expect(ledger[1]).toEqual({ userId: 'user-4', email: null, token: tokenFor('d') });
  });
});

describe('normaliseAccountEmail', () => {
  it("matches the backend's trim().toLowerCase()", () => {
    expect(normaliseAccountEmail('\t Mixed.Case@Example.ORG \n')).toBe('mixed.case@example.org');
  });
});
