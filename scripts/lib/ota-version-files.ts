/** Files whose eoas spec names the publishing CLI, shared by the writer and parity checks. */
export const EOAS_SPEC_FILES = [
  'docs/mobile-ota-updates.md',
  'scripts/mobile-ota-setup.ts',
  'scripts/mobile-ota-rollback.ts',
  '.github/workflows/mobile-ota-backport.yml',
  'CLAUDE.md',
  'AGENTS.md',
] as const;

/** The backport workflow names only the CLI; the remaining references also name the image. */
export const SERVER_IMAGE_FILES = EOAS_SPEC_FILES.filter(
  (path) => path !== '.github/workflows/mobile-ota-backport.yml',
);

/** The publisher source pin participates in rewrites, but is the parity check's source of truth. */
export const VERSION_BEARING_FILES = [...EOAS_SPEC_FILES, 'scripts/lib/eoas.ts'] as const;
