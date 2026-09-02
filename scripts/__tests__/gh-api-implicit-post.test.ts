/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { githubYamlPaths, withoutCommentLines } from './helpers/workflow-yaml';

/**
 * `gh api` picks its HTTP method implicitly: GET normally, but **POST** as soon
 * as any `-f` / `-F` / `--field` / `--raw-field` parameter is set.
 *
 * So writing a query parameter the natural-looking way:
 *
 *   gh api --paginate -F per_page=100 "repos/OWNER/REPO/actions/runners"
 *
 * silently issues `POST /actions/runners` — a route that does not exist. The
 * response is a bare `404 Not Found`, which is indistinguishable from a token
 * that lacks permission on the resource.
 *
 * That is not hypothetical: it took down ci-runner-watchdog.yml on every
 * scheduled run, and the 404 sent us through several rounds of rebuilding a
 * fine-grained PAT before the method turned out to be the culprit. The token
 * had been correct the whole time.
 *
 * The rule: query parameters belong in the URL. Use `-f`/`-F` only for a real
 * request body, alongside an explicit `-X`.
 */

const FIELD_FLAG = /(^|\s)(-f|-F|--field|--raw-field)(\s|=)/;
const EXPLICIT_METHOD = /(^|\s)(-X|--method)(\s|=)/;

/** Whole `gh api ...` invocations, rejoined across YAML line continuations. */
function ghApiInvocations(source: string): string[] {
  const lines = withoutCommentLines(source);
  const invocations: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (!/(^|[\s"'(=$])gh api(\s|$)/.test(lines[index])) continue;

    let invocation = lines[index];
    // A backslash at end-of-line continues the shell command onto the next.
    while (/\\\s*$/.test(invocation) && index + 1 < lines.length) {
      index += 1;
      invocation = `${invocation.replace(/\\\s*$/, '')} ${lines[index].trim()}`;
    }
    invocations.push(invocation);
  }
  return invocations;
}

describe('gh api calls never take an implicit POST', () => {
  for (const workflowPath of githubYamlPaths()) {
    const source = readFileSync(workflowPath, 'utf8');
    const invocations = ghApiInvocations(source);
    if (invocations.length === 0) continue;

    it(`${workflowPath} passes query params in the URL, not via -f/-F`, () => {
      const offenders = invocations.filter(
        (invocation) => FIELD_FLAG.test(invocation) && !EXPLICIT_METHOD.test(invocation),
      );

      expect(
        offenders,
        'gh api switches to POST when any -f/-F field is set, so these would hit a ' +
          'route that does not exist and return a 404 that looks exactly like a ' +
          'permissions failure. Put query parameters in the URL, or add an explicit -X.',
      ).toEqual([]);
    });
  }
});
