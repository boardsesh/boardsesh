/// <reference types="node" />

// Decides whether a freshly-resolved runtimeVersion is the same native fingerprint
// as one a shipped binary embeds. Used by the production OTA workflow when a native
// build asks it to republish: `main` may have moved on to a native change since the
// binary was built, and publishing under the NEW fingerprint would ship JS that
// assumes native code the old binary lacks.
//
// The comparison lives here rather than inline in YAML for one reason: an inverted
// `!=` in a shell script is invisible to a workflow-text assertion and silently
// disables the guard. A pure function can be unit-tested against both directions.
// Invoked from YAML the same way scripts/ota-preview-cleanup.ts is
// (`node --experimental-strip-types`).

import { SHORT_FP_LENGTH } from './lib/release-tags.ts';

/**
 * True when both fingerprints agree on their first {@link SHORT_FP_LENGTH} hex
 * characters. Case-insensitive: the tags a native build pushes are lowercase, but
 * a resolver returning uppercase must not read as a mismatch. Anything shorter
 * than the prefix, or not hex, is never a match — a truncated or error value must
 * fail closed rather than compare equal to another truncated value.
 */
export function fingerprintPrefixMatches(resolved: string, expected: string): boolean {
  const left = normalizeFingerprint(resolved);
  const right = normalizeFingerprint(expected);
  if (left === null || right === null) return false;
  return left === right;
}

/** Lowercased {@link SHORT_FP_LENGTH}-char prefix, or null when it isn't a usable fingerprint. */
export function normalizeFingerprint(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  if (!new RegExp(`^[0-9a-f]{${SHORT_FP_LENGTH},}$`).test(trimmed)) return null;
  return trimmed.slice(0, SHORT_FP_LENGTH);
}

function readFlag(argv: string[], flag: string): string {
  const index = argv.indexOf(flag);
  return index >= 0 ? (argv[index + 1] ?? '') : '';
}

function main(): void {
  const argv = process.argv.slice(2).filter((arg) => arg !== '--');
  const resolved = readFlag(argv, '--resolved');
  const expected = readFlag(argv, '--expected');
  // Print the verdict for `>> "$GITHUB_OUTPUT"`. A mismatch is a SKIP, not a
  // failure — a new binary is already building for the new fingerprint — so this
  // always exits 0 and lets the workflow decide what to do with `mismatch`.
  const mismatch = !fingerprintPrefixMatches(resolved, expected);
  process.stdout.write(`mismatch=${mismatch}\n`);
}

// Only run the CLI when executed directly, so the pure exports stay importable
// from tests without side effects.
if (process.argv[1]?.endsWith('mobile-fingerprint-match.ts')) main();
