/**
 * Files whose eoas spec names the publishing CLI, shared by the writer and parity checks.
 *
 * No file under `.github/workflows/` belongs here. The bump workflow pushes with a
 * GitHub App that has Contents write only; GitHub rejects any push that edits a
 * workflow file unless the App also holds Workflows write, so a workflow that named
 * the version would make every generated bump fail at `git push`. Workflows point at
 * scripts/lib/eoas.ts instead, and eoas-version-parity.test.ts keeps it that way.
 */
export const EOAS_SPEC_FILES = [
  'docs/mobile-ota-updates.md',
  'scripts/mobile-ota-setup.ts',
  'scripts/mobile-ota-rollback.ts',
  'CLAUDE.md',
  'AGENTS.md',
] as const;

/** Every CLI reference file also names the server image. */
export const SERVER_IMAGE_FILES = EOAS_SPEC_FILES;

/** The publisher source pin participates in rewrites, but is the parity check's source of truth. */
export const VERSION_BEARING_FILES = [...EOAS_SPEC_FILES, 'scripts/lib/eoas.ts'] as const;
