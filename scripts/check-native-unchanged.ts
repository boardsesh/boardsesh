/// <reference types="node" />
// #7596 acceptance 7: native iOS and Android behaviour is unchanged by the web
// session cutover. Every file under packages/mobile or packages/shared without
// a `.web` suffix ships to phones by OTA, so the web lane (the stacked #7596
// branches) may change none of them, except:
//
//   - packages/shared/auth-protocol/**, while no native entry imports
//     `@boardsesh/auth-protocol` (checked here, on the tree being tested);
//   - NATIVE_CHANGE_ALLOWLIST below, one reason each.
//
// Usage: `vp exec tsx scripts/check-native-unchanged.ts <base ref>`, e.g.
// `origin/main`. It compares the merge base with HEAD, so only the branch's
// own changes count. Exit code 1 lists every file that breaks the rule.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';

/**
 * Native-reachable files the web lane changes on purpose. Built from the
 * stack's actual diff against main (2026-11-18: #7802, #7777, and the
 * Settings lane #7804 to #7809 merged in #7810). The locale files may only
 * gain keys, which `jsonAdditionViolations` enforces; the mobile bundle
 * carries them unused.
 */
export const NATIVE_CHANGE_ALLOWLIST: Readonly<Record<string, string>> = Object.freeze({
  'packages/shared/text-redaction/src/password-recovery.ts':
    'Adds the first-party session cookie names to log redaction; on a phone it only scrubs names no native request sends.',
  'packages/shared/text-redaction/src/__tests__/browser-session-cookie.test.ts':
    'Test of that redaction; tests are not in any bundle.',
  'packages/shared/text-redaction/src/__tests__/password-recovery.test.ts':
    'Test of the provider-flow redaction (#7805); tests are not in any bundle.',
  'packages/shared/i18n/locales/de/auth.json':
    'Settings lane (#7804): adds www-only auth error strings; no existing key changes and no native screen reads them.',
  'packages/shared/i18n/locales/de/settings.json':
    'Settings lane (#7807, #7809): adds www-only sign-in methods strings; no existing key changes and no native screen reads them.',
  'packages/shared/i18n/locales/en-US/auth.json':
    'Settings lane (#7804): adds www-only auth error strings; no existing key changes and no native screen reads them.',
  'packages/shared/i18n/locales/en-US/settings.json':
    'Settings lane (#7807, #7809): adds www-only sign-in methods strings; no existing key changes and no native screen reads them.',
  'packages/shared/i18n/locales/es/auth.json':
    'Settings lane (#7804): adds www-only auth error strings; no existing key changes and no native screen reads them.',
  'packages/shared/i18n/locales/es/settings.json':
    'Settings lane (#7807, #7809): adds www-only sign-in methods strings; no existing key changes and no native screen reads them.',
  'packages/shared/i18n/locales/fr/auth.json':
    'Settings lane (#7804): adds www-only auth error strings; no existing key changes and no native screen reads them.',
  'packages/shared/i18n/locales/fr/settings.json':
    'Settings lane (#7807, #7809): adds www-only sign-in methods strings; no existing key changes and no native screen reads them.',
  'packages/shared/i18n/locales/it/auth.json':
    'Settings lane (#7804): adds www-only auth error strings; no existing key changes and no native screen reads them.',
  'packages/shared/i18n/locales/it/settings.json':
    'Settings lane (#7807, #7809): adds www-only sign-in methods strings; no existing key changes and no native screen reads them.',
  'packages/shared/i18n/locales/zh-CN/auth.json':
    'Adds Simplified Chinese messages for www reauthentication and first-password confirmation; native screens use none of the new keys.',
  'packages/shared/i18n/locales/zh-CN/settings.json':
    'Adds Simplified Chinese messages for www sign-in methods and password setup; native screens use none of the new keys.',
});

const AUTH_PROTOCOL_ROOT = 'packages/shared/auth-protocol/';
const AUTH_PROTOCOL_IMPORT = /['"]@boardsesh\/auth-protocol(?:\/[^'"]*)?['"]/;
const SOURCE_FILE = /\.[cm]?[jt]sx?$/;

/** A file only the browser build loads: `name.web.ts`, `name.web.tsx`, and their tests. */
export function isWebOnly(path: string): boolean {
  return /\.web(?:\.test)?\.[cm]?[jt]sx?$/.test(path);
}

function shipsToPhones(path: string): boolean {
  return (path.startsWith('packages/mobile/') || path.startsWith('packages/shared/')) && !isWebOnly(path);
}

function isTestFile(path: string): boolean {
  return path.includes('/__tests__/') || /\.test\.[cm]?[jt]sx?$/.test(path);
}

/** Native source outside auth-protocol that imports it, which would put auth-protocol in the phone bundle. */
export function authProtocolNativeImporters(sources: ReadonlyArray<{ path: string; text: string }>): string[] {
  return sources
    .filter(({ path }) => shipsToPhones(path) && !path.startsWith(AUTH_PROTOCOL_ROOT) && SOURCE_FILE.test(path))
    .filter(({ path }) => !isTestFile(path))
    .filter(({ text }) => AUTH_PROTOCOL_IMPORT.test(text))
    .map(({ path }) => path);
}

/** Every changed file that breaks the rule, with why. */
export function nativeChangeViolations(changedPaths: readonly string[], nativeImporters: readonly string[]): string[] {
  const violations: string[] = [];
  for (const path of changedPaths) {
    if (!shipsToPhones(path) || path in NATIVE_CHANGE_ALLOWLIST) continue;
    if (path.startsWith(AUTH_PROTOCOL_ROOT)) {
      if (nativeImporters.length > 0)
        violations.push(`${path}: auth-protocol is imported by native code (${nativeImporters.join(', ')})`);
      continue;
    }
    violations.push(`${path}: ships to phones and is not on the allowlist`);
  }
  return violations;
}

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** Every leaf of a parsed JSON document as `dotted.path` to its value. */
function leaves(document: Json, prefix = '', into = new Map<string, string>()): Map<string, string> {
  if (document !== null && typeof document === 'object') {
    for (const [key, child] of Object.entries(document)) leaves(child, prefix ? `${prefix}.${key}` : key, into);
  } else {
    into.set(prefix, JSON.stringify(document));
  }
  return into;
}

/**
 * For an allowlisted locale file: what the head removed or changed of the base.
 * Additions are allowed; a removed or changed key ships a different string to phones.
 */
export function jsonAdditionViolations(path: string, baseText: string, headText: string): string[] {
  const base = leaves(JSON.parse(baseText) as Json);
  const head = leaves(JSON.parse(headText) as Json);
  const violations: string[] = [];
  for (const [key, value] of base) {
    if (!head.has(key)) violations.push(`${path}: removes ${key}`);
    else if (head.get(key) !== value) violations.push(`${path}: changes ${key}`);
  }
  return violations;
}

function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function main(): number {
  const base = process.argv.slice(2).find((argument) => argument !== '--');
  if (!base) {
    console.error('Usage: check-native-unchanged.ts <base ref>');
    return 2;
  }
  const changed = git(['diff', '--name-only', `${base}...HEAD`, '--', 'packages/mobile', 'packages/shared'])
    .split('\n')
    .filter(Boolean);
  const tracked = git(['ls-files', 'packages/mobile', 'packages/shared']).split('\n').filter(Boolean);
  const importers = authProtocolNativeImporters(
    tracked.filter((path) => SOURCE_FILE.test(path)).map((path) => ({ path, text: readFileSync(path, 'utf8') })),
  );
  const violations = nativeChangeViolations(changed, importers);
  // An allowlisted locale file may only gain keys: enforced, not taken on trust.
  const mergeBase = git(['merge-base', base, 'HEAD']).trim();
  for (const path of changed.filter(
    (candidate) => candidate in NATIVE_CHANGE_ALLOWLIST && candidate.endsWith('.json'),
  )) {
    const show = (revision: string) => {
      try {
        return git(['show', `${revision}:${path}`]);
      } catch {
        return '{}';
      }
    };
    violations.push(...jsonAdditionViolations(path, show(mergeBase), show('HEAD')));
  }
  const stale = Object.keys(NATIVE_CHANGE_ALLOWLIST).filter((path) => !changed.includes(path));
  console.info(
    `[native-unchanged] ${changed.length} changed file(s) under packages/mobile and packages/shared since ${base}; ` +
      `${changed.filter(isWebOnly).length} are .web only.`,
  );
  if (stale.length > 0) console.info(`[native-unchanged] allowlist entries no longer changed: ${stale.join(', ')}`);
  if (violations.length === 0) return 0;
  console.error(`[native-unchanged] ${violations.length} change(s) would reach phones:\n${violations.join('\n')}`);
  return 1;
}

if (process.argv[1] && process.argv[1].endsWith('check-native-unchanged.ts')) process.exitCode = main();
