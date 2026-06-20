/// <reference types="node" />

/**
 * Fails (exit 1) when a PR has no non-empty `## Release Notes` section, unless it
 * explicitly opts out: the template's "No release note needed" checkbox is ticked,
 * or the `skip-changelog` label is present. An empty/missing section still fails
 * (a forgotten note, not a deliberate skip). This is the copy source the changelog
 * generator reads, so a mobile/shared PR without it would ship an OTA with nothing
 * to show users.
 *
 * Inputs (designed so CI never has to shell-escape a multi-line markdown body):
 *   --body-file <path>   Read the PR body from a file (CI writes
 *                        github.event.pull_request.body to it). Falls back to
 *                        stdin when the flag is absent.
 *   PR_LABELS env        JSON array of label objects ([{ "name": "..." }, ...],
 *                        the shape of github.event.pull_request.labels) OR a
 *                        plain comma-separated list. Empty/unset = no labels.
 *
 * Usage:
 *   vp run check:release-notes -- --body-file pr-body.txt   (PR_LABELS in env)
 */

import { readFileSync } from 'node:fs';
import { extractReleaseNotes, isNoReleaseNoteBoxChecked, SKIP_LABEL } from './lib/changelog-transform';

function readBody(): string {
  const args = process.argv.slice(2);
  const bodyFileFlag = args.indexOf('--body-file');
  if (bodyFileFlag !== -1) {
    const path = args[bodyFileFlag + 1];
    if (!path) {
      console.error('[release-notes] --body-file given without a path.');
      process.exit(1);
    }
    return readFileSync(path, 'utf8');
  }
  // No file flag: read from stdin (fd 0).
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function parseLabels(raw: string | undefined): string[] {
  if (!raw || !raw.trim()) return [];
  const trimmed = raw.trim();
  // GitHub's labels payload is a JSON array of objects with a `name`. Accept that
  // shape, a JSON array of strings, or a plain comma-separated list.
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

function main(): void {
  const labels = parseLabels(process.env.PR_LABELS);
  if (labels.includes(SKIP_LABEL)) {
    console.log(`[release-notes] "${SKIP_LABEL}" label present — Release Notes not required.`);
    return;
  }

  const body = readBody();
  if (isNoReleaseNoteBoxChecked(body)) {
    console.log('[release-notes] "No release note needed" checkbox ticked — Release Notes not required.');
    return;
  }

  const notes = extractReleaseNotes(body);
  if (notes) {
    console.log(`[release-notes] OK — "${notes.title}"`);
    return;
  }

  console.error(
    [
      '✖ This PR has no usable "## Release Notes" section.',
      '',
      'Add a "## Release Notes" section to the PR description describing what the',
      'user gets (climber voice, one short line per change). See the PR template.',
      'For an internal/technical change with nothing user-facing, tick the',
      `"No release note needed" checkbox in the template (or apply the "${SKIP_LABEL}" label).`,
    ].join('\n'),
  );
  process.exit(1);
}

main();
