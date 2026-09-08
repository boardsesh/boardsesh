/// <reference types="node" />

/**
 * Closes the iOS screenshot probe's blind spot.
 *
 * The probe (mobile-screenshots-ios.yml) only ever captures one shard —
 * en-US x iPhone 16 Pro Max — and compares it pixel-for-pixel against the
 * stored baseline. That is a fine proxy for most UI changes, but it is BLIND
 * to a change confined to a locale other than en-US (Spanish/French/German
 * strings) or to an iPad-only layout: the probe shard never touches that code
 * path, so it always reports "unchanged" and the fan-out that would have
 * caught the real diff never runs.
 *
 * This script closes that gap with changed-file knowledge instead of pixels:
 * given the paths that changed between the stored baseline's commit and the
 * commit under test, it decides whether the probe should be overridden and the
 * full 12-shard capture forced regardless of what the pixel comparison found.
 *
 * Usage:
 *   vp run screenshot:probe-scope -- --changed-files-file <path>
 *   vp run screenshot:probe-scope -- --unreachable-baseline "<reason>"
 *
 * `--changed-files-file` points at a newline-separated list of repo-relative
 * paths (typically `git diff --name-only <baseline_commit> <source_sha>` piped
 * to a file). `--unreachable-baseline` is the escape hatch for when the
 * baseline commit itself cannot be diffed at all (no baseline yet, or a commit
 * that fell out of history) — in that case there is nothing to compare, so the
 * fan-out is forced out of caution rather than guessed at.
 *
 * Pure decision logic lives in decideProbeScope() so every rule below has a
 * direct unit test; this file's CLI is just argument parsing and GitHub
 * Actions output wiring.
 */

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const LOG = '[screenshot:probe-scope]';

export interface ProbeScopeRule {
  /** Short machine-friendly identifier, stable across edits to the description. */
  name: string;
  /** Human-readable explanation surfaced in the forced-full reason and step summary. */
  description: string;
  /** True when `path` (repo-relative, forward-slash separated) falls in this rule's scope. */
  matches: (path: string) => boolean;
}

const SHARED_I18N_LOCALES_PREFIX = 'packages/shared/i18n/locales/';
const MOBILE_LOCALES_PREFIX = 'packages/mobile/locales/';
const MOBILE_PREFIX = 'packages/mobile/';
const IPAD_TABLET_PATTERN = /ipad|tablet/i;
const MOBILE_APP_CONFIG_PATH = 'packages/mobile/app.config.ts';
const APP_STORES_APPLE_PREFIX = 'app-stores/apple/';

/**
 * The five documented scopes the probe cannot see. Order matters only for
 * which reason is reported first when a change matches more than one — every
 * matching rule still forces the same outcome.
 */
export const PROBE_SCOPE_RULES: readonly ProbeScopeRule[] = [
  {
    name: 'shared-i18n-non-en-us-locale',
    description: 'a non-en-US shared i18n catalog under packages/shared/i18n/locales/**',
    matches: (path) => path.startsWith(SHARED_I18N_LOCALES_PREFIX) && !path.startsWith(`${SHARED_I18N_LOCALES_PREFIX}en-US/`),
  },
  {
    name: 'mobile-locales',
    description: 'a mobile locale resource under packages/mobile/locales/**',
    matches: (path) => path.startsWith(MOBILE_LOCALES_PREFIX),
  },
  {
    name: 'mobile-ipad-tablet',
    description: 'an iPad/tablet-specific mobile path (matches /ipad|tablet/i under packages/mobile/)',
    matches: (path) => path.startsWith(MOBILE_PREFIX) && IPAD_TABLET_PATTERN.test(path),
  },
  {
    name: 'mobile-app-config',
    description: 'the native app config packages/mobile/app.config.ts',
    matches: (path) => path === MOBILE_APP_CONFIG_PATH,
  },
  {
    name: 'app-store-metadata',
    description: 'App Store metadata under app-stores/apple/**',
    matches: (path) => path.startsWith(APP_STORES_APPLE_PREFIX),
  },
];

export interface ProbeScopeDecision {
  forceFull: boolean;
  reason: string;
}

/**
 * Pure: does anything in `changedFiles` fall in a scope the single-shard probe
 * cannot see? The probe shoots en-US on an iPhone, so a locale-only or
 * iPad-only change would otherwise report "unchanged" and skip the fan-out
 * that would have caught it.
 */
export function decideProbeScope(changedFiles: readonly string[]): ProbeScopeDecision {
  for (const rule of PROBE_SCOPE_RULES) {
    const matchedFile = changedFiles.find((path) => rule.matches(path));
    if (matchedFile !== undefined) {
      return { forceFull: true, reason: `${matchedFile} matches ${rule.description}, which the probe shard cannot see` };
    }
  }
  return {
    forceFull: false,
    reason: 'no changed path falls outside what the en-US x iPhone 16 Pro Max probe shard already covers',
  };
}

/** A baseline commit that cannot be diffed at all is treated as "force full", not "no signal". */
export function decideProbeScopeForUnreachableBaseline(reason: string): ProbeScopeDecision {
  return { forceFull: true, reason: `baseline commit unreachable (${reason}); forcing a full capture out of caution` };
}

function readChangedFiles(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

interface CliOptions {
  changedFilesFile: string | null;
  unreachableBaseline: string | null;
}

export function parseProbeScopeArguments(argv: readonly string[]): CliOptions {
  const args = argv.filter((argument) => argument !== '--');
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag.startsWith('--')) throw new Error(`Unknown argument: ${flag}`);
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    values.set(flag, value);
  }

  const known = ['--changed-files-file', '--unreachable-baseline'];
  for (const flag of values.keys()) {
    if (!known.includes(flag)) throw new Error(`Unknown argument: ${flag}`);
  }

  const changedFilesFile = values.get('--changed-files-file') ?? null;
  const unreachableBaseline = values.get('--unreachable-baseline') ?? null;
  if (!changedFilesFile && !unreachableBaseline) {
    throw new Error('either --changed-files-file <path> or --unreachable-baseline "<reason>" is required');
  }

  return { changedFilesFile, unreachableBaseline };
}

/** `force_full=` / `reason=` for the probe job step this feeds. */
export function writeGithubOutput(outputFile: string, decision: ProbeScopeDecision): void {
  const flatReason = decision.reason.replace(/\s+/g, ' ').trim();
  appendFileSync(outputFile, `force_full=${decision.forceFull}\nreason=${flatReason}\n`);
}

function main(argv: readonly string[]): number {
  let options: CliOptions;
  try {
    options = parseProbeScopeArguments(argv);
  } catch (error) {
    console.error(`${LOG} ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  const decision = options.unreachableBaseline
    ? decideProbeScopeForUnreachableBaseline(options.unreachableBaseline)
    : decideProbeScope(readChangedFiles(options.changedFilesFile ?? ''));

  console.log(`${LOG} force_full=${decision.forceFull}: ${decision.reason}`);

  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput) writeGithubOutput(githubOutput, decision);

  const stepSummary = process.env.GITHUB_STEP_SUMMARY;
  if (stepSummary) {
    appendFileSync(
      stepSummary,
      decision.forceFull
        ? `**Probe scope: forcing a full capture** — ${decision.reason}.\n`
        : `Probe scope: ${decision.reason}.\n`,
    );
  }

  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
