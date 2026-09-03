/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const WORKFLOW_PATH = '.github/workflows/ci.yml';
const VITE_CONFIG_PATH = 'vite.config.ts';
const OXLINTRC_PATH = '.oxlintrc.json';

const workflowSource = readFileSync(WORKFLOW_PATH, 'utf8');

/**
 * Return one YAML mapping entry by exact key and indentation. Copied from
 * ci-location-sync-workflow.test.ts on purpose: the repo declares no YAML
 * parser, and a CI contract test is not worth the dependency churn.
 */
function mappingEntry(source: string, key: string, indentation: number): string {
  const lines = source.split('\n');
  const prefix = `${' '.repeat(indentation)}${key}:`;
  const startIndex = lines.findIndex((line) => line.startsWith(prefix));
  if (startIndex < 0) {
    throw new Error(`missing ${key} mapping at indentation ${indentation}`);
  }

  let endIndex = lines.length;
  for (let lineIndex = startIndex + 1; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const lineIndentation = line.length - line.trimStart().length;
    if (lineIndentation <= indentation) {
      endIndex = lineIndex;
      break;
    }
  }

  return lines.slice(startIndex, endIndex).join('\n');
}

/** Strip `#` comment lines so a rule's rationale can never satisfy an assertion. */
function withoutComments(source: string): string {
  return source
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
}

/** Read a single-level string-array literal out of a TS source by property name. */
function stringArrayLiteral(source: string, property: string): string[] {
  const startIndex = source.indexOf(`${property}: [`);
  if (startIndex < 0) throw new Error(`missing ${property} array`);
  const openIndex = source.indexOf('[', startIndex);
  const closeIndex = source.indexOf(']', openIndex);
  if (closeIndex < 0) throw new Error(`unterminated ${property} array`);
  return [...source.slice(openIndex + 1, closeIndex).matchAll(/'([^']*)'/g)].map((match) => match[1]);
}

describe('CI lint scope contract', () => {
  const lintJob = mappingEntry(workflowSource, 'lint', 2);
  const lintSteps = withoutComments(lintJob);

  it('lints the whole repo exactly once, with no per-event branch', () => {
    // The gap this pins shut: the job used to lint only a PR's changed files and
    // reserve the full-repo pass for push-to-main, so an error in a file no PR
    // touched could only ever be discovered after it landed. 33 of them did
    // (issue #4488). PR and main scope must stay identical by construction.
    expect(lintSteps.match(/vp check/g)).toHaveLength(1);
    expect(lintSteps).toContain('- name: Lint full repo');
    expect(lintSteps).not.toContain('Lint changed files');
  });

  it('runs no step of the lint job conditionally on the event type', () => {
    expect(lintSteps).not.toContain('github.event_name');
    expect(lintSteps).not.toContain('github.base_ref');
  });

  it('derives no file list from a diff', () => {
    expect(lintSteps).not.toContain('git diff');
    expect(lintSteps).not.toContain('changed-lintable');
    expect(lintSteps).not.toContain('--changed');
  });

  it('keeps the stdout redirect that stops vp panicking on a long warning list', () => {
    // vp/Vite+ panics with EAGAIN flushing the full-repo warning list to the
    // runner's non-blocking stdout. Every PR now prints that list, so losing this
    // redirect would turn a clean lint into a mystery exit code.
    expect(lintSteps).toContain('vp check > vp-check.log 2>&1 && status=0 || status=$?');
    expect(lintSteps).toContain('exit $status');
  });

  it('names an OOM-killed tsgolint instead of leaving a bare exit code', () => {
    // The vite-plus 0.3.0 bump (oxlint-tsgolint 0.23 -> 7.0.2001, #5108) pushed
    // the full-repo type-aware pass past the memory a self-hosted slot has, and
    // the kernel killed tsgolint. All the job surfaced was "Process completed
    // with exit code 1": oxlint's own line is "Linting could not start", and the
    // one piece of hard evidence is a `signal: 'SIGKILL'` buried in a Node stack
    // inside the redirected log. Keep the annotation that reads that stack for us.
    expect(lintSteps).toContain(`grep -q "signal: 'SIGKILL'" vp-check.log`);
    expect(lintSteps).toContain('::error::tsgolint was killed by the OS');
    expect(lintSteps).toContain('/sys/fs/cgroup/memory.max');
  });

  it('still runs when only the workflow itself changes', () => {
    const changesJob = mappingEntry(workflowSource, 'changes', 2);
    const rootCiFilter = mappingEntry(changesJob, 'rootCi', 12);
    expect(rootCiFilter).toContain("- '.github/workflows/ci.yml'");
    expect(lintJob).toContain("needs.changes.outputs.rootCi == 'true'");
  });
});

describe('lint ignore scope', () => {
  it('never ignores a path that .oxlintrc.json lints', () => {
    // `vp check` reads the `lint` block in vite.config.ts, not .oxlintrc.json
    // (issue #4548). The two are hand-duplicated, so this pins the direction that
    // costs coverage: vp must not skip a path oxlint would have flagged.
    const viteIgnores = stringArrayLiteral(readFileSync(VITE_CONFIG_PATH, 'utf8'), 'ignorePatterns');
    const oxlintConfig = JSON.parse(readFileSync(OXLINTRC_PATH, 'utf8')) as { ignorePatterns: string[] };

    expect(viteIgnores.length).toBeGreaterThan(0);
    for (const pattern of viteIgnores) {
      expect(oxlintConfig.ignorePatterns).toContain(pattern);
    }
  });
});

describe('markdown is out of formatting scope', () => {
  /**
   * The formatter's emphasis pairing does not follow CommonMark's
   * intraword-underscore rule. On `docs/websocket-implementation.md` it paired
   * the `_` inside the bare identifier `NOT_FOUND` with a later `_signed-in_`
   * and emitted `NOT*FOUND` + `\_signed-in*` — corrupting an identifier in
   * prose, reproducibly, on every `vp check --fix`.
   *
   * Prose gains little from auto-formatting and carries content the formatter
   * can get wrong, so `.md` is excluded. It has to be excluded in BOTH places:
   * `vp check` reads the `fmt.ignore` block, but a full-repo run only honours
   * `.prettierignore` for some path forms (see the note above that list).
   */
  const MARKDOWN_GLOB = '**/*.md';
  const PRETTIERIGNORE_PATH = '.prettierignore';

  it('excludes markdown in vite.config.ts fmt.ignore', () => {
    const fmtIgnores = stringArrayLiteral(readFileSync(VITE_CONFIG_PATH, 'utf8'), 'ignore');
    expect(fmtIgnores).toContain(MARKDOWN_GLOB);
  });

  it('excludes markdown in .prettierignore too', () => {
    // Belt and braces on purpose: dropping either one silently reinstates
    // formatting for the path forms the other does not cover.
    const patterns = readFileSync(PRETTIERIGNORE_PATH, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
    expect(patterns).toContain('*.md');
  });
});
