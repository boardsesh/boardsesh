/**
 * Parses the PR's changed paths as CI hands them to a body check: one path per
 * line, the shape `pulls.listFiles` filenames are written in by
 * `.github/workflows/pr-test-plan.yml`. Blank lines and surrounding whitespace
 * are dropped; CRLF is tolerated.
 */
export function parseChangedPaths(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}
