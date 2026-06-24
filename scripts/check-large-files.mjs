/**
 * Fails (exit 1) when a change adds or grows a tracked file past a size
 * threshold, unless the path sits under an allowlist of intentionally-large
 * assets.
 *
 * This is the backstop for the 2026 repo-size cleanup: history had bloated to a
 * 1.66 GiB pack, ~1 GB of it dead screenshot dumps committed by CI. Once the
 * dead branches were pruned, this guard keeps binary churn (committed
 * screenshots, build outputs, vendored binaries) from quietly creeping back in.
 *
 * Enforcement is the `large-files` CI job (see .github/workflows/ci.yml), not
 * the local pre-commit hook — the check is repo/diff-scoped, not per-file like
 * `vp check`. Run it locally with `vp run check:large-files` before pushing.
 *
 * Modes:
 *   (default)   Diff against a base ref and check only Added/Modified/Renamed
 *               files — PR-friendly, never trips on pre-existing large files.
 *               Falls back to a full scan if the base/merge-base isn't reachable
 *               (e.g. a shallow clone too shallow to find the merge-base), so a
 *               deep PR fails loudly on a real offender rather than crashing.
 *   --all       Scan every tracked file (audit / main-branch regression check).
 *
 * Base ref (default mode), in order: `--base <ref>`, then `origin/$GITHUB_BASE_REF`,
 * then `origin/main`.
 *
 * Usage:
 *   node scripts/check-large-files.mjs --base origin/main   # CI PR
 *   node scripts/check-large-files.mjs --all                # audit
 *   vp run check:large-files -- --base origin/main
 */

import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const MAX_BYTES = 2_000_000; // 2 MB

// Path prefixes where large binaries are intentional. Keep this short and
// justified — every entry is a place the pack is explicitly allowed to grow.
// Removing an entry (e.g. board-renderer, once libs build on demand) re-arms
// the guard for that path.
export const ALLOWLIST = [
  {
    prefix: 'packages/moonboard-ocr/src/__tests__/fixtures/',
    reason: 'OCR test fixtures — full-resolution board photos are required for hold detection',
  },
  {
    prefix: 'packages/mobile/modules/board-renderer/',
    reason: 'Prebuilt Rust FFI libs (xcframework / jniLibs) — vendored until built on demand',
  },
  {
    prefix: 'design/',
    reason: 'Design-system reference renders',
  },
];

export function allowlistEntryFor(filePath) {
  return ALLOWLIST.find((entry) => filePath.startsWith(entry.prefix));
}

export function formatBytes(bytes) {
  return `${(bytes / 1_000_000).toFixed(2)} MB`;
}

/**
 * Pure classifier: split weighed files into allowlisted-large and violations.
 * @param {{ filePath: string, sizeBytes: number }[]} weighedFiles
 */
export function evaluate(weighedFiles) {
  const violations = [];
  const allowedLarge = [];
  for (const { filePath, sizeBytes } of weighedFiles) {
    if (sizeBytes <= MAX_BYTES) continue;
    const allowed = allowlistEntryFor(filePath);
    if (allowed) {
      allowedLarge.push({ filePath, sizeBytes, reason: allowed.reason });
    } else {
      violations.push({ filePath, sizeBytes });
    }
  }
  violations.sort((left, right) => right.sizeBytes - left.sizeBytes);
  return { violations, allowedLarge };
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function refExists(ref) {
  try {
    git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

function resolveBaseRef(argv) {
  const flagIndex = argv.indexOf('--base');
  const candidates = [];
  if (flagIndex !== -1 && argv[flagIndex + 1]) candidates.push(argv[flagIndex + 1]);
  if (process.env.GITHUB_BASE_REF) candidates.push(`origin/${process.env.GITHUB_BASE_REF}`);
  candidates.push('origin/main');
  return candidates.find((candidate) => refExists(candidate)) ?? null;
}

function allTrackedFiles() {
  return git(['ls-files']).split('\n').filter(Boolean);
}

function candidateFiles(argv) {
  if (argv.includes('--all')) return allTrackedFiles();

  const base = resolveBaseRef(argv);
  if (!base) {
    console.warn('[large-files] No base ref resolved — scanning all tracked files instead.');
    return allTrackedFiles();
  }
  try {
    const changed = git(['diff', '--name-only', '--diff-filter=ACMR', `${base}...HEAD`])
      .split('\n')
      .filter(Boolean);
    console.log(`[large-files] Checking files changed since ${base}.`);
    return changed;
  } catch {
    // Most likely the merge-base isn't in a shallow clone. Don't crash the
    // gate on infrastructure — fall back to a full scan, which still catches
    // any new non-allowlisted offender.
    console.warn(`[large-files] Could not diff against ${base} (shallow clone?) — scanning all tracked files instead.`);
    return allTrackedFiles();
  }
}

function weigh(filePaths) {
  const weighed = [];
  for (const filePath of filePaths) {
    try {
      const stats = statSync(filePath);
      if (stats.isFile()) weighed.push({ filePath, sizeBytes: stats.size });
    } catch {
      // deleted or renamed-away — nothing to weigh
    }
  }
  return weighed;
}

function main() {
  const argv = process.argv.slice(2);
  const { violations, allowedLarge } = evaluate(weigh(candidateFiles(argv)));

  if (allowedLarge.length) {
    console.log(`[large-files] ${allowedLarge.length} allowlisted large file(s) — OK.`);
  }

  if (!violations.length) {
    console.log(`[large-files] OK — no new files over ${formatBytes(MAX_BYTES)}.`);
    return;
  }

  console.error(
    [
      `✖ ${violations.length} file(s) exceed the ${formatBytes(MAX_BYTES)} limit:`,
      ...violations.map(({ filePath, sizeBytes }) => `    ${formatBytes(sizeBytes).padStart(9)}  ${filePath}`),
      '',
      'Large binaries bloat every clone forever (they delta-compress poorly and',
      'stay in history). Before committing one:',
      '  • Compress or downscale it, or generate it at build time instead.',
      '  • Host it externally (CDN / release asset) and fetch it on demand.',
      '  • If it genuinely must be tracked, add its path prefix to ALLOWLIST in',
      '    scripts/check-large-files.mjs with a one-line reason.',
    ].join('\n'),
  );
  process.exit(1);
}

// Run only when invoked directly, so the test module can import the helpers.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
