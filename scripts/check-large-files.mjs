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
 * Modes:
 *   (default)   Diff against a base ref and check only Added/Modified/Renamed
 *               files — PR-friendly, never trips on pre-existing large files.
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

const MAX_BYTES = 2_000_000; // 2 MB

// Path prefixes where large binaries are intentional. Keep this short and
// justified — every entry is a place the pack is explicitly allowed to grow.
// Removing an entry (e.g. board-renderer, once libs build on demand) re-arms
// the guard for that path.
const ALLOWLIST = [
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

  for (const candidate of candidates) {
    if (refExists(candidate)) return candidate;
  }
  console.error(
    `[large-files] Could not resolve a base ref (tried: ${candidates.join(', ')}).\n` +
      '  In CI, fetch the base branch first; locally, pass --base <ref> or --all.',
  );
  process.exit(1);
}

function candidateFiles(argv) {
  if (argv.includes('--all')) {
    return git(['ls-files']).split('\n').filter(Boolean);
  }
  const base = resolveBaseRef(argv);
  console.log(`[large-files] Checking files changed since ${base}.`);
  return git(['diff', '--name-only', '--diff-filter=ACMR', `${base}...HEAD`])
    .split('\n')
    .filter(Boolean);
}

function allowlistEntryFor(filePath) {
  return ALLOWLIST.find((entry) => filePath.startsWith(entry.prefix));
}

function formatBytes(bytes) {
  return `${(bytes / 1_000_000).toFixed(2)} MB`;
}

function main() {
  const argv = process.argv.slice(2);
  const violations = [];
  const allowedLarge = [];

  for (const filePath of candidateFiles(argv)) {
    let sizeBytes;
    try {
      const stats = statSync(filePath);
      if (!stats.isFile()) continue;
      sizeBytes = stats.size;
    } catch {
      continue; // deleted or renamed-away — nothing to weigh
    }
    if (sizeBytes <= MAX_BYTES) continue;

    const allowed = allowlistEntryFor(filePath);
    if (allowed) {
      allowedLarge.push({ filePath, sizeBytes, reason: allowed.reason });
    } else {
      violations.push({ filePath, sizeBytes });
    }
  }

  if (allowedLarge.length) {
    console.log(`[large-files] ${allowedLarge.length} allowlisted large file(s) — OK.`);
  }

  if (!violations.length) {
    console.log(`[large-files] OK — no new files over ${formatBytes(MAX_BYTES)}.`);
    return;
  }

  violations.sort((left, right) => right.sizeBytes - left.sizeBytes);
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

main();
