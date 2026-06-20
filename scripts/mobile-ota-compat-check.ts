/// <reference types="node" />

/**
 * Tells a PR reviewer, on every non-main branch push, whether a mobile change
 * rides over-the-air on existing app binaries or forces a new TestFlight/Play
 * build. It answers the one question the runtimeVersion `fingerprint` policy
 * (packages/mobile/app.config.ts) makes load-bearing: an OTA update only reaches
 * a binary whose fingerprint matches, so a JS-only change keeps the fingerprint
 * (ships OTA in minutes) while a native change (deps, plugins, entitlements,
 * config) moves it (needs a new binary first).
 *
 * Verdict = DIFF vs origin/main, resolved in ONE job under identical env:
 *
 *   fingerprint(PR tree, platform) === fingerprint(main tree, platform)
 *     → ota-compatible            (no native delta vs main)
 *   …differ                       → native-change-required
 *   …either side unresolved       → unknown (neutral, never blocks)
 *
 * Why diff-vs-main and not "does a shipped fingerprint-<platform>-<hash> tag
 * exist": the equality verdict is invariant to env imperfections. A missing
 * GOOGLE_MAPS_API_KEY (a Production-environment secret, unavailable on
 * feature-branch pushes — see .github/workflows/android-apk-rn.yml) shifts BOTH
 * sides of the comparison by the same constant, so the PR-vs-main delta is still
 * detected. The absolute hash never has to match production; only the relative
 * diff matters. A tag lookup would instead need the branch push to reproduce the
 * production hash exactly (maps key + cross-OS determinism) and would falsely
 * report "native change" on every Android PR. The tag lookup is kept only as a
 * SECONDARY, informational signal ("already on a released build"), surfaced only
 * when confidently true.
 *
 * This never fails the PR: a native change is a legitimate outcome, not an error.
 * The signal is the comment / step-summary / check-run content, not pass/fail.
 *
 * Usage:
 *   vp run check:mobile-ota-compat -- --write-env --base-dir <main-worktree> [--check-shipped-tags]
 *   vp run check:mobile-ota-compat -- --base-fingerprint-ios <h> --base-fingerprint-android <h>
 *
 * The CI workflow (.github/workflows/mobile-ota-check.yml) materializes the
 * baseline as a git worktree of origin/main with its own `bun install`, then
 * passes it via --base-dir. Run locally the same way:
 *   git worktree add /tmp/main-baseline origin/main
 *   (cd /tmp/main-baseline && bun install --frozen-lockfile)
 *   vp run check:mobile-ota-compat -- --write-env --base-dir /tmp/main-baseline
 */

import { appendFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * `bunx expo-updates runtimeversion:resolve` is intermittently non-deterministic
 * (≈5% of invocations its autolinking step computes a hash off a different source
 * set, or fails outright and yields null), so a single resolve can't be trusted
 * to mean "the fingerprint changed". The check confirms a *difference* (and
 * retries a *null*) before acting: a real native change stays different across
 * re-resolves, a flake collapses back to equal, a transient null recovers. An
 * "equal" is trusted immediately (two independent trees won't collide on a wrong
 * hash). Worst case is MAX_DIFF_CONFIRMATIONS + 1 resolves per side per platform
 * (≈12 total) — only when reads never settle; the common path is one each.
 */
const MAX_DIFF_CONFIRMATIONS = 5;

export type Platform = 'ios' | 'android';
export type Verdict = 'ota-compatible' | 'native-change-required' | 'unknown';

export const PLATFORMS: readonly Platform[] = ['ios', 'android'];

/** The sticky-comment marker (matches the upsert logic in the workflow). */
export const STICKY_MARKER = '<!-- mobile-ota-check -->';

/**
 * The .env keys whose values are hashed into the fingerprint (via the written
 * .env file) — byte-identical to the heredoc the native build / gate jobs write.
 * The script owns writing this into BOTH the PR and baseline trees so they can
 * never diverge (a divergence would make every PR falsely read "native change").
 */
export const ENV_KEYS: readonly string[] = [
  'EXPO_PUBLIC_BACKEND_URL',
  'EXPO_PUBLIC_WS_URL',
  'EXPO_PUBLIC_WEB_URL',
  'EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID',
  'EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID',
  'EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID',
  'EXPO_PUBLIC_SENTRY_DSN',
  'EXPO_PUBLIC_POSTHOG_KEY',
];

/** Same shape the native gates accept: a lowercase hex hash, ≥8 chars. */
const FINGERPRINT_RE = /^[0-9a-f]{8,}$/i;

export interface PlatformResult {
  platform: Platform;
  /** Resolved fingerprint of the PR tree, or null if it couldn't be resolved. */
  prFingerprint: string | null;
  /** Resolved fingerprint of the origin/main baseline, or null if unavailable. */
  baseFingerprint: string | null;
  verdict: Verdict;
  /** Secondary signal: a released binary already carries the PR fingerprint. null = not checked. */
  shippedTagExists: boolean | null;
}

export interface OtaCompatResult {
  results: PlatformResult[];
  overall: Verdict;
}

export interface CommentContext {
  sha: string;
  branch: string;
}

/** PURE: a single platform verdict from the PR and baseline fingerprints. */
export function deriveVerdict(prFingerprint: string | null, baseFingerprint: string | null): Verdict {
  if (!prFingerprint || !baseFingerprint) return 'unknown';
  return prFingerprint === baseFingerprint ? 'ota-compatible' : 'native-change-required';
}

/**
 * PURE: fold per-platform verdicts into the headline. Precedence:
 * native-change-required > unknown > ota-compatible — a confident native verdict
 * on one platform is never masked by an "unknown" on the other, and a single
 * "unknown" downgrades an otherwise-compatible headline to honest uncertainty.
 */
export function deriveOverall(results: readonly PlatformResult[]): Verdict {
  if (results.length === 0) return 'unknown';
  if (results.some((entry) => entry.verdict === 'native-change-required')) return 'native-change-required';
  if (results.some((entry) => entry.verdict === 'unknown')) return 'unknown';
  return 'ota-compatible';
}

export interface FingerprintPair {
  prFingerprint: string | null;
  baseFingerprint: string | null;
}

/**
 * PURE (given injected resolvers): resolve a platform's PR and baseline
 * fingerprints, smoothing over the resolver's intermittent flakiness so it can't
 * surface as a false "native change" or a spurious "unknown".
 *
 * - An equal, non-null pair is trusted immediately (two independent trees won't
 *   collide on a wrong hash).
 * - A difference or a null on either side is retried, up to `maxConfirmations`
 *   re-resolves: a flaky difference collapses back to equal, a transient null
 *   recovers to a real hash. A genuine native change stays different — detected
 *   when the same non-null differing pair repeats — and returns after one
 *   confirmation. A side that is *persistently* null (or never settles) falls
 *   through to a null result → an honest "unknown" verdict.
 *
 * `resolveBase` may be backed by a fixed value (the cache-hit path); then only
 * the PR side actually changes across retries, and the PR converging to that
 * constant is what confirms equality. Keep the resolvers cheap and idempotent —
 * each is called up to `maxConfirmations + 1` times.
 */
export function confirmComparison(
  resolvePr: () => string | null,
  resolveBase: () => string | null,
  maxConfirmations: number = MAX_DIFF_CONFIRMATIONS,
): FingerprintPair {
  let prFingerprint = resolvePr();
  let baseFingerprint = resolveBase();
  let previousPr = prFingerprint;
  let previousBase = baseFingerprint;

  for (let attempt = 0; attempt < maxConfirmations; attempt += 1) {
    if (prFingerprint && baseFingerprint && prFingerprint === baseFingerprint) {
      return { prFingerprint, baseFingerprint };
    }
    // A non-null differing pair seen twice running → a stable, genuine native
    // change (attempt > 0 so we never short-circuit before re-resolving once).
    if (
      attempt > 0 &&
      prFingerprint &&
      baseFingerprint &&
      prFingerprint === previousPr &&
      baseFingerprint === previousBase
    ) {
      break;
    }
    // Otherwise re-resolve: a difference may be a flake, a null may be a
    // transient resolve failure — both can recover on re-read. Keep the last
    // non-null reading so a later null doesn't erase a good hash.
    previousPr = prFingerprint;
    previousBase = baseFingerprint;
    const pr = resolvePr();
    const base = resolveBase();
    if (pr) prFingerprint = pr;
    if (base) baseFingerprint = base;
  }
  return { prFingerprint, baseFingerprint };
}

function shortHash(fingerprint: string | null): string {
  return fingerprint ? fingerprint.slice(0, 12) : '—';
}

const PLATFORM_LABEL: Record<Platform, string> = { ios: 'iOS', android: 'Android' };

const VERDICT_CELL: Record<Verdict, string> = {
  'ota-compatible': '✅ Compatible',
  'native-change-required': '⚠️ Native change',
  unknown: 'ℹ️ Unknown',
};

const HEADLINE: Record<Verdict, string> = {
  'ota-compatible':
    '✅ **Ships over-the-air.** No native change versus `main` — this lands on existing builds via OTA.',
  'native-change-required':
    "⚠️ **Native change detected.** This won't reach users over-the-air; it needs a new TestFlight/Play " +
    'build before it ships. (Merge is not blocked — native changes are expected.)',
  unknown: "ℹ️ **OTA compatibility unknown.** Couldn't establish a `main` baseline this run, so no verdict.",
};

/** A short title for the non-blocking GitHub check-run. */
export const CHECK_TITLE: Record<Verdict, string> = {
  'ota-compatible': 'OTA-compatible — rides existing builds',
  'native-change-required': 'Native change — needs a new TestFlight/Play build',
  unknown: 'OTA compatibility unknown (no baseline)',
};

/**
 * PURE: the fingerprint cell for one platform. Each hash is labelled (no bare
 * arrow) so it reads as two static snapshots, not a state transition:
 *   compatible → `abc` (matches main)
 *   native     → PR `abc` · main `def`
 *   unknown    → `abc` (no baseline)  /  `—` (unresolved)
 */
function fingerprintCell(entry: PlatformResult): string {
  if (entry.verdict === 'ota-compatible') {
    const cell = `\`${shortHash(entry.prFingerprint)}\` (matches \`main\`)`;
    // Secondary signal — only ever stated when confidently true.
    return entry.shippedTagExists ? `${cell} · already on a released build` : cell;
  }
  if (entry.verdict === 'native-change-required') {
    return `PR \`${shortHash(entry.prFingerprint)}\` · main \`${shortHash(entry.baseFingerprint)}\``;
  }
  // unknown — name why we couldn't compare rather than show a bare em-dash pair.
  return entry.baseFingerprint
    ? `\`${shortHash(entry.prFingerprint)}\` (unresolved)`
    : `\`${shortHash(entry.prFingerprint)}\` (no baseline)`;
}

function table(results: readonly PlatformResult[]): string {
  const rows = results.map(
    (entry) => `| ${PLATFORM_LABEL[entry.platform]} | ${VERDICT_CELL[entry.verdict]} | ${fingerprintCell(entry)} |`,
  );
  return ['| Platform | Verdict | Fingerprint |', '| --- | --- | --- |', ...rows].join('\n');
}

/** PURE: render the sticky PR comment markdown. */
export function renderComment(result: OtaCompatResult, ctx: CommentContext): string {
  return [
    STICKY_MARKER,
    '### 📱 OTA compatibility',
    '',
    HEADLINE[result.overall],
    '',
    table(result.results),
    '',
    `Branch \`${ctx.branch}\` · commit \`${ctx.sha.slice(0, 7)}\`.`,
    '',
    '<sub>Fingerprint is resolved per platform against `main`. iOS native builds run on `main` ' +
      'only, so the iOS verdict is computed versus `main`’s tree. See `docs/mobile-ota-updates.md`.</sub>',
  ].join('\n');
}

/** PURE: render the `$GITHUB_STEP_SUMMARY` markdown. */
export function renderSummary(result: OtaCompatResult): string {
  return ['## OTA compatibility', '', HEADLINE[result.overall], '', table(result.results), ''].join('\n');
}

// ─── I/O (everything below shells out / touches the filesystem) ───────────────

/** Pull the fingerprint hash out of `expo-updates runtimeversion:resolve` stdout. */
export function parseRuntimeVersion(stdout: string): string | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  const candidates = [trimmed, trimmed.match(/\{[\s\S]*\}/)?.[0]].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as { runtimeVersion?: unknown };
      const value = parsed.runtimeVersion;
      if (typeof value === 'string' && FINGERPRINT_RE.test(value)) return value;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

/** Write the byte-identical `.env` (the 8 EXPO_PUBLIC_* vars) into a mobile dir. */
function writeEnv(mobileDir: string): void {
  const body = ENV_KEYS.map((key) => `${key}=${process.env[key] ?? ''}`).join('\n');
  writeFileSync(resolve(mobileDir, '.env'), `${body}\n`);
}

/**
 * Resolve one platform's fingerprint by shelling the same CLI the native gates
 * use. Returns null on any failure (mirrors the gates' `|| true` tolerance).
 * iOS resolves WITHOUT GOOGLE_MAPS_API_KEY, Android WITH it — applied identically
 * to PR and baseline so the equality verdict holds regardless of the key.
 *
 * May intermittently return a wrong hash (see MAX_DIFF_CONFIRMATIONS) — callers
 * must confirm a difference, never act on a single differing read.
 */
function resolveFingerprint(mobileDir: string, platform: Platform): string | null {
  const childEnv = { ...process.env };
  if (platform === 'ios') delete childEnv.GOOGLE_MAPS_API_KEY;
  try {
    const stdout = execFileSync('bunx', ['expo-updates', 'runtimeversion:resolve', '--platform', platform], {
      cwd: mobileDir,
      env: childEnv,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 32 * 1024 * 1024,
    });
    return parseRuntimeVersion(stdout);
  } catch {
    return null;
  }
}

/** Secondary signal: does a released binary already carry this fingerprint? */
function shippedTagExists(platform: Platform, fingerprint: string): boolean {
  try {
    execFileSync(
      'git',
      ['ls-remote', '--exit-code', '--tags', 'origin', `refs/tags/fingerprint-${platform}-${fingerprint}`],
      {
        stdio: 'ignore',
      },
    );
    return true;
  } catch {
    return false;
  }
}

interface Options {
  prMobileDir: string;
  baseMobileDir: string | null;
  baseFingerprints: Partial<Record<Platform, string>>;
  writeEnvFiles: boolean;
  checkShippedTags: boolean;
}

export function parseArgs(argv: readonly string[], repoRoot: string): Options {
  const options: Options = {
    prMobileDir: resolve(repoRoot, 'packages', 'mobile'),
    baseMobileDir: null,
    baseFingerprints: {},
    writeEnvFiles: false,
    checkShippedTags: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = (): string => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`missing value for ${flag}`);
      index += 1;
      return value;
    };
    switch (flag) {
      case '--':
        // `vp run <task> -- <args>` forwards a literal `--` separator as argv[0];
        // it carries no meaning here, so skip it.
        break;
      case '--pr-dir':
        options.prMobileDir = resolve(next(), 'packages', 'mobile');
        break;
      case '--base-dir':
        options.baseMobileDir = resolve(next(), 'packages', 'mobile');
        break;
      case '--base-fingerprint-ios':
        options.baseFingerprints.ios = next();
        break;
      case '--base-fingerprint-android':
        options.baseFingerprints.android = next();
        break;
      case '--write-env':
        options.writeEnvFiles = true;
        break;
      case '--check-shipped-tags':
        options.checkShippedTags = true;
        break;
      default:
        throw new Error(`unknown argument: ${flag}`);
    }
  }
  return options;
}

function emitGithubOutputs(result: OtaCompatResult, ctx: CommentContext): void {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (outputPath) {
    const verdictFor = (platform: Platform): Verdict =>
      result.results.find((entry) => entry.platform === platform)?.verdict ?? 'unknown';
    const commentB64 = Buffer.from(renderComment(result, ctx), 'utf8').toString('base64');
    appendFileSync(
      outputPath,
      [
        `overall=${result.overall}`,
        `verdict_ios=${verdictFor('ios')}`,
        `verdict_android=${verdictFor('android')}`,
        `check_title=${CHECK_TITLE[result.overall]}`,
        `comment_b64=${commentB64}`,
        '',
      ].join('\n'),
    );
  }
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) appendFileSync(summaryPath, `${renderSummary(result)}\n`);
}

/** Wire the real filesystem / subprocesses and run the check. Returns the exit code. */
export function main(argv: readonly string[] = process.argv.slice(2)): number {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const options = parseArgs(argv, repoRoot);

  if (options.writeEnvFiles) {
    writeEnv(options.prMobileDir);
    if (options.baseMobileDir) writeEnv(options.baseMobileDir);
  }

  const results: PlatformResult[] = PLATFORMS.map((platform) => {
    // Re-read the baseline the same way each attempt: a provided value is fixed,
    // a worktree is re-resolved so a flaky baseline read can also self-correct.
    const readBaseFingerprint = (): string | null =>
      options.baseFingerprints[platform] ??
      (options.baseMobileDir ? resolveFingerprint(options.baseMobileDir, platform) : null);

    const { prFingerprint, baseFingerprint } = confirmComparison(
      () => resolveFingerprint(options.prMobileDir, platform),
      readBaseFingerprint,
    );

    if (!prFingerprint) {
      console.warn(
        `::warning::Could not resolve the ${platform} fingerprint — reporting OTA compatibility as unknown.`,
      );
    }
    if (!baseFingerprint) {
      console.warn(`::warning::No ${platform} baseline fingerprint — reporting OTA compatibility as unknown.`);
    }

    const verdict = deriveVerdict(prFingerprint, baseFingerprint);
    const tagExists =
      options.checkShippedTags && prFingerprint && verdict === 'ota-compatible'
        ? shippedTagExists(platform, prFingerprint)
        : null;

    return { platform, prFingerprint, baseFingerprint, verdict, shippedTagExists: tagExists };
  });

  const result: OtaCompatResult = { results, overall: deriveOverall(results) };

  for (const entry of result.results) {
    console.log(
      `[mobile-ota-compat] ${PLATFORM_LABEL[entry.platform]}: ${entry.verdict} ` +
        `(pr=${shortHash(entry.prFingerprint)} main=${shortHash(entry.baseFingerprint)})`,
    );
  }
  console.log(`[mobile-ota-compat] overall: ${result.overall}`);

  emitGithubOutputs(result, {
    sha: process.env.GITHUB_SHA ?? 'local',
    branch: process.env.GITHUB_REF_NAME ?? 'local',
  });

  // Never fail the PR — a native change is legitimate. The signal is the content.
  return 0;
}

// Run only when executed directly (tsx scripts/mobile-ota-compat-check.ts), not
// when imported by the unit test.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
