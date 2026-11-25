import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vite-plus/test';

/**
 * Every password compare an unauthenticated caller can reach goes through the
 * per-account guess limit (#7656), or is listed here with the reason it does
 * not. A new compare, or a new caller of a compare helper, fails this test until
 * it is wired or reviewed into the lists below.
 */
const BACKEND_SOURCE = fileURLToPath(new URL('../../', import.meta.url));

/** Files that run bcrypt's compare themselves. */
const REVIEWED_COMPARES: Readonly<Record<string, string>> = {
  'auth/current-store/password-identity.ts': 'Shared helper behind native and staged/default web password sign-in.',
  'auth/current-store/password-login-family.ts':
    'Default password sign-in: sequential candidate comparisons under its handler whole-command work slot and account guess admission; the slot stays held until actual command settlement.',
  'auth/authority/authority.ts':
    'verifyAuthorityPassword: helper behind the two entry points, and the Better Auth identity authority, which serves no email sign-in route.',
  'auth/authority/first-password-finalizer.ts':
    'Signed-in first-password enrollment hashes a password; compare in comments refers to stored row shape checks, not password guessing.',
  'auth/authority/provider-reauthentication-evidence.ts':
    'Re-authentication for a provider security change: the caller already holds a signed-in session for the account.',
};

/** Who may call a compare helper, and why that caller is covered. */
const REVIEWED_HELPER_CALLERS: Readonly<Record<string, string>> = {
  'auth/authority/password-verification.ts': 'authenticateIdentityPassword: called only by native credentials sign-in.',
  'auth/current-store/web-password.ts': 'authenticateWebPassword: called only by the staged password command.',
  'auth/current-store/password-login-family.ts':
    'authenticatePasswordBeforeEnforcement: the default password handler admits account guesses before the family; its whole-command work slot encloses the matcher and sequential bcrypt callback.',
  'auth/current-store/password-identity.ts': 'Defines the helpers; authenticateCurrentStorePassword has no route.',
  'auth/authority/authority.ts': 'Defines verifyAuthorityPassword.',
  'auth/authority/provider-security-reauthentication.ts': 'Signed-in re-authentication, see above.',
};

/** The entry points, and the guard each caller must run before calling them. */
const GUARDED_ENTRY_POINTS = [
  'authenticateIdentityPassword(',
  'authenticateWebPassword(',
  'authenticatePasswordBeforeEnforcement(',
];
const GUARDED_CALLERS = [
  'handlers/native-auth.ts',
  'handlers/current-store-web-auth.ts',
  'handlers/current-store-password-login.ts',
];
const GUARD = 'passwordGuessLimiter().admit(';

function productionSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : productionSources(path);
    return entry.name.endsWith('.ts') && !/\.(test|proof)\.ts$/.test(entry.name) ? [path] : [];
  });
}

const sources = productionSources(BACKEND_SOURCE).map((path) => ({
  path: relative(BACKEND_SOURCE, path),
  text: readFileSync(path, 'utf8'),
}));

describe('password compare inventory (#7656)', () => {
  it('lists every file that runs a bcrypt compare, however bcrypt is imported', () => {
    // Any import form (named, renamed, default, namespace, require) of bcrypt or
    // bcryptjs, in a file that names compare or compareSync anywhere.
    const importsBcrypt = /from\s+['"]bcrypt(?:js)?['"]|require\(\s*['"]bcrypt(?:js)?['"]\s*\)/;
    const comparing = sources
      .filter(({ text }) => importsBcrypt.test(text) && /\bcompare(?:Sync)?\b/.test(text))
      .map(({ path }) => path)
      .sort();
    expect(comparing).toEqual(Object.keys(REVIEWED_COMPARES).sort());
  });

  it('catches the import forms it claims to', () => {
    const importsBcrypt = /from\s+['"]bcrypt(?:js)?['"]|require\(\s*['"]bcrypt(?:js)?['"]\s*\)/;
    for (const form of [
      "import * as hashing from 'bcryptjs'; hashing.compareSync(a, b);",
      "import hashing from 'bcryptjs'; await hashing.compare(a, b);",
      "import { compare as check } from 'bcrypt';",
      "const hashing = require('bcryptjs'); hashing.compare(a, b);",
    ])
      expect(importsBcrypt.test(form) && /\bcompare(?:Sync)?\b/.test(form), form).toBe(true);
  });

  it('lists every caller of a compare helper', () => {
    const helpers = [
      'verifyAuthorityPassword(',
      'matchCurrentStorePasswordCandidate(',
      'authenticateCurrentStorePassword(',
      'verifyProviderPasswordReauthentication(',
    ];
    const callers = sources
      .filter(({ text }) => helpers.some((helper) => text.includes(helper)))
      .map(({ path }) => path)
      .sort();
    expect(callers).toEqual(
      [
        ...new Set([...Object.keys(REVIEWED_HELPER_CALLERS), 'auth/authority/provider-reauthentication-evidence.ts']),
      ].sort(),
    );
  });

  it('counts the default password sites and orders admission inside its whole-command work slot', () => {
    const family = sources.find(({ path }) => path === 'auth/current-store/password-login-family.ts')?.text ?? '';
    const handler = sources.find(({ path }) => path === 'handlers/current-store-password-login.ts')?.text ?? '';
    expect(family.match(/\bcompare\s*\(/g)).toHaveLength(1);
    expect(family.match(/\bmatchCurrentStorePasswordCandidate\s*\(/g)).toHaveLength(1);
    expect(handler.match(/\bauthenticatePasswordBeforeEnforcement\s*\(/g)).toHaveLength(1);
    const clientAdmissionAt = handler.indexOf('await guards.limits.admit(');
    const commandSlotAt = handler.indexOf('await guards.gate.run(');
    const guessAdmissionAt = handler.indexOf(GUARD);
    const familyAt = handler.indexOf('await authenticatePasswordBeforeEnforcement(');
    expect(clientAdmissionAt).toBeGreaterThan(0);
    expect(clientAdmissionAt).toBeLessThan(commandSlotAt);
    expect(commandSlotAt).toBeLessThan(guessAdmissionAt);
    expect(guessAdmissionAt).toBeLessThan(familyAt);
    expect(familyAt).toBeLessThan(handler.indexOf('}, callerGone.signal)'));
  });

  it('runs the guess limit before each sign-in entry point', () => {
    const callers = sources
      .filter(
        ({ path, text }) =>
          GUARDED_ENTRY_POINTS.some((entry) => text.includes(entry)) &&
          !path.endsWith('password-verification.ts') &&
          !path.endsWith('web-password.ts') &&
          path !== 'auth/current-store/password-login-family.ts',
      )
      .map(({ path }) => path)
      .sort();
    expect(callers).toEqual([...GUARDED_CALLERS].sort());
    for (const path of GUARDED_CALLERS) {
      const text = sources.find((source) => source.path === path)?.text ?? '';
      const guardAt = text.indexOf(GUARD);
      expect(guardAt, path).toBeGreaterThan(0);
      // Every call of an entry point in the file, not only the first, comes after the guard.
      for (const entry of GUARDED_ENTRY_POINTS) {
        let callAt = text.indexOf(entry);
        while (callAt >= 0) {
          expect(guardAt, `${path} admits before ${entry} at ${callAt}`).toBeLessThan(callAt);
          callAt = text.indexOf(entry, callAt + entry.length);
        }
      }
    }
  });
});
