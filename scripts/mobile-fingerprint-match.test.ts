/// <reference types="node" />

import { execFileSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { fingerprintPrefixMatches, normalizeFingerprint } from './mobile-fingerprint-match';

const SHIPPED = '532b90278dac7a6a85f320ebe51cc73ba645f6cf';
const OTHER = '67881966076e4f92ecc1a7c7b64a43d177e57019';

describe('fingerprintPrefixMatches', () => {
  // The whole point of extracting this: an inverted comparison in YAML would
  // disable the republish guard while every workflow-text assertion stayed green.
  // Both directions are asserted so a flipped operator can't survive.
  it('matches a fingerprint against itself and rejects a different one', () => {
    expect(fingerprintPrefixMatches(SHIPPED, SHIPPED)).toBe(true);
    expect(fingerprintPrefixMatches(SHIPPED, OTHER)).toBe(false);
  });

  it('compares only the short prefix, so a full hash matches its tag form', () => {
    expect(fingerprintPrefixMatches(SHIPPED, SHIPPED.slice(0, 12))).toBe(true);
    // Differs only after the prefix — the native tag can't distinguish these, so
    // neither may this.
    expect(fingerprintPrefixMatches(SHIPPED, `${SHIPPED.slice(0, 12)}${'0'.repeat(28)}`)).toBe(true);
  });

  it('ignores case and surrounding whitespace from a shell capture', () => {
    expect(fingerprintPrefixMatches(SHIPPED.toUpperCase(), SHIPPED)).toBe(true);
    expect(fingerprintPrefixMatches(`  ${SHIPPED}\n`, SHIPPED)).toBe(true);
  });

  // Fail closed: an empty or truncated resolve is a resolver error, not a match.
  // Two blank values comparing equal would republish under an unverified
  // fingerprint, which is exactly what the guard exists to prevent.
  it('never matches an unusable fingerprint, including two identical blanks', () => {
    expect(fingerprintPrefixMatches('', '')).toBe(false);
    expect(fingerprintPrefixMatches('abc', 'abc')).toBe(false);
    expect(fingerprintPrefixMatches('not-hex-value', SHIPPED)).toBe(false);
    expect(fingerprintPrefixMatches(SHIPPED, '')).toBe(false);
  });
});

describe('normalizeFingerprint', () => {
  it('returns the lowercased short prefix or null', () => {
    expect(normalizeFingerprint(SHIPPED.toUpperCase())).toBe('532b90278dac');
    expect(normalizeFingerprint('532b90278da')).toBeNull();
    expect(normalizeFingerprint('')).toBeNull();
  });
});

// Vitest resolves `./lib/release-tags` (no extension) through its own bundler-style
// resolver, so the tests above pass even when the specifier is missing the `.ts`
// extension Node's native ESM loader requires. The production OTA workflow invokes
// this file with plain `node --experimental-strip-types`, which has no such
// fallback — that gap shipped a broken republish job (ERR_MODULE_NOT_FOUND) that
// every unit test above stayed green through. Spawn it exactly as the workflow does.
describe('CLI invocation (node --experimental-strip-types)', () => {
  it('resolves its imports and prints a verdict, matching the workflow invocation', () => {
    const scriptPath = new URL('./mobile-fingerprint-match.ts', import.meta.url).pathname;
    const stdout = execFileSync(
      process.execPath,
      ['--experimental-strip-types', scriptPath, '--resolved', SHIPPED, '--expected', SHIPPED],
      { encoding: 'utf8' },
    );
    expect(stdout.trim()).toBe('mismatch=false');
  });
});
