/**
 * Parses the PR labels CI hands a body check via the `PR_LABELS` env var.
 * Accepts GitHub's `github.event.pull_request.labels` shape (a JSON array of
 * objects with a `name`), a JSON array of strings, or a plain comma-separated
 * list. Empty/unset = no labels. Shared by check-release-notes and
 * check-pr-test-plan so both gates read labels the same way.
 */
export function parseLabels(raw: string | undefined): string[] {
  if (!raw || !raw.trim()) return [];
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) {
        return parsed
          .map((label) =>
            typeof label === 'string'
              ? label
              : typeof (label as { name?: unknown }).name === 'string'
                ? (label as { name: string }).name
                : '',
          )
          .filter(Boolean);
      }
    } catch {
      // Fall through to comma-split on malformed JSON.
    }
  }
  return trimmed
    .split(',')
    .map((label) => label.trim())
    .filter(Boolean);
}
