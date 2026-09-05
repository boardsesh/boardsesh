/// <reference types="node" />

import { describe, expect, it } from 'vitest';

import { OTA_IMAGE_REPOSITORY } from '../infra/railway/config';
import {
  GHCR_REPOSITORY,
  VERSION_BEARING_FILES,
  githubOutputLines,
  isPrerelease,
  parseArgs,
  pullRequestBody,
  rewriteVersionMentions,
  selectCandidates,
} from './ota-image-bump';
import type { BumpReport } from './ota-image-bump';

/**
 * The real tag list, as GHCR returned it on 2026-09-05.
 *
 * Kept verbatim rather than reduced to a tidy fixture, because the messiness is
 * the point: two prerelease spellings (`v3.0.0-beta.3` dotted, `v3.1.2-beta2`
 * undotted), a floating `latest` that is not a version at all, and a v2 tag that
 * sorts below everything current and must never be proposed as an upgrade.
 */
const UPSTREAM_TAGS = [
  'v3.0.0-beta.3',
  'v3.0.0-beta.4',
  'v3.0.0-beta.6',
  'v3.0.0-beta.7',
  'v3.0.0-beta.8',
  'v3.0.0-beta.10',
  'v3.0.0',
  'latest',
  'v3.0.1',
  'v3.0.2',
  'v3.0.3',
  'v3.0.4',
  'v3.0.5',
  'v3.1.0',
  'v3.1.1',
  'v3.1.2-beta',
  'v3.1.2-beta2',
  'v3.1.2-beta3',
  'v3.1.2-beta4',
  'v3.1.2',
  'v3.1.3',
  'v3.2.0-beta1',
  'v2.3.23',
  'v3.2.0-beta2',
  'v3.2.0-beta3',
];

describe('parseArgs', () => {
  it('reports by default', () => {
    expect(parseArgs([])).toEqual({ json: false, githubOutput: false, write: null, prBody: null, help: false });
  });

  it('accepts --json and the -- separator vp forwards', () => {
    expect(parseArgs(['--', '--json'])).toEqual({
      json: true,
      githubOutput: false,
      write: null,
      prBody: null,
      help: false,
    });
  });

  it('takes a version to render a PR body for', () => {
    expect(parseArgs(['--pr-body', 'v3.1.3']).prBody).toBe('3.1.3');
    expect(() => parseArgs(['--pr-body'])).toThrow(/needs a version/);
  });

  it('emits key=value lines for a workflow on request', () => {
    expect(parseArgs(['--github-output']).githubOutput).toBe(true);
  });

  it('takes a version to write, with or without the v prefix', () => {
    expect(parseArgs(['--write', '3.1.3']).write).toBe('3.1.3');
    expect(parseArgs(['--write', 'v3.2.0-beta3']).write).toBe('3.2.0-beta3');
  });

  it('refuses --write with no version rather than writing something surprising', () => {
    expect(() => parseArgs(['--write'])).toThrow(/needs a version/);
    expect(() => parseArgs(['--write', '--json'])).toThrow(/needs a version/);
  });

  it('rejects a typo rather than silently reporting when a write was meant', () => {
    expect(() => parseArgs(['--wirte', '3.1.3'])).toThrow(/Unknown flag/);
  });
});

describe('isPrerelease', () => {
  it('recognises both spellings upstream actually publishes', () => {
    expect(isPrerelease('3.0.0-beta.3')).toBe(true);
    expect(isPrerelease('3.2.0-beta1')).toBe(true);
    expect(isPrerelease('3.1.3')).toBe(false);
  });
});

describe('selectCandidates', () => {
  it('tracks stable and prerelease separately, so a beta never hides a stable upgrade', () => {
    // 3.2.0-beta3 outranks 3.1.3 by semver. A single "highest version" search
    // would propose the beta and silently bury the stable release, which is the
    // whole reason these are two answers rather than one.
    expect(selectCandidates(UPSTREAM_TAGS, '3.1.2')).toEqual({ stable: '3.1.3', prerelease: '3.2.0-beta3' });
  });

  it('ignores tags that are not versions', () => {
    expect(selectCandidates(['latest', 'main', 'sha-abc123'], '3.1.2')).toEqual({ stable: null, prerelease: null });
  });

  it('never proposes an older release, however high its major looks in a string sort', () => {
    // 'v2.3.23' string-sorts above 'v3.1.2' on its patch digits alone.
    const { stable, prerelease } = selectCandidates(UPSTREAM_TAGS, '3.1.3');
    expect(stable).toBeNull();
    expect(prerelease).toBe('3.2.0-beta3');
  });

  it('reports nothing when the deployed version is already the newest of both kinds', () => {
    expect(selectCandidates(UPSTREAM_TAGS, '3.2.0-beta3')).toEqual({ stable: null, prerelease: null });
  });

  it('does not treat a prerelease of the current version as an upgrade', () => {
    // 3.1.2-beta4 precedes 3.1.2. Proposing it would be a downgrade wearing a
    // higher-looking tag.
    expect(selectCandidates(['v3.1.2-beta4'], '3.1.2')).toEqual({ stable: null, prerelease: null });
  });

  it('orders undotted prerelease identifiers numerically, not lexically', () => {
    // beta10 must outrank beta2; a string compare would put 'beta10' first.
    expect(selectCandidates(['v3.3.0-beta2', 'v3.3.0-beta10'], '3.1.2').prerelease).toBe('3.3.0-beta10');
  });
});

describe('the repository it watches', () => {
  it('strips the registry host for the GHCR API path', () => {
    expect(OTA_IMAGE_REPOSITORY).toBe(`ghcr.io/${GHCR_REPOSITORY}`);
    expect(GHCR_REPOSITORY).not.toContain('ghcr.io');
  });
});

describe('the files a bump rewrites', () => {
  it('covers every file the version-parity test polices', () => {
    // A bump that misses one of these lands a PR that fails its own CI. Keeping
    // the two lists in step is the only thing standing between an automated bump
    // and a red branch nobody asked for.
    for (const relativePath of [
      'docs/mobile-ota-updates.md',
      'scripts/mobile-ota-setup.ts',
      'scripts/mobile-ota-rollback.ts',
      '.github/workflows/mobile-ota-backport.yml',
      'CLAUDE.md',
      'AGENTS.md',
    ]) {
      expect(VERSION_BEARING_FILES).toContain(relativePath);
    }
  });

  it('includes the CLI pin itself, which is where eoas@<version> lives', () => {
    expect(VERSION_BEARING_FILES).toContain('scripts/lib/eoas.ts');
  });
});

describe('pullRequestBody', () => {
  it('carries the sections pr-test-plan.yml requires, so the bump PR passes its own gate', () => {
    const body = pullRequestBody('3.1.3', '3.1.2');
    expect(body).toContain('## Test plan');
    expect(body).toContain('## Release Notes');
    expect(body).toContain('## Risk');
    expect(body).toMatch(/Risk: \d\/5/);
  });

  it('names both the version it leaves and the one it moves to', () => {
    const body = pullRequestBody('3.1.3', '3.1.2');
    expect(body).toContain('`3.1.2`');
    expect(body).toContain('`3.1.3`');
    expect(body).toContain('releases/tag/v3.1.3');
  });

  it('says plainly when the candidate is a prerelease, and stays quiet when it is not', () => {
    expect(pullRequestBody('3.2.0-beta3', '3.1.2')).toContain('This is a prerelease');
    expect(pullRequestBody('3.1.3', '3.1.2')).not.toContain('This is a prerelease');
  });

  it('reminds the reader to re-check the ClickHouse system log TTLs', () => {
    // A server image upgrade can recreate a system.*_log table without its TTL,
    // and those logs outgrow the Observe data by about a hundred times.
    expect(pullRequestBody('3.1.3', '3.1.2')).toContain('system.*_log');
  });
});

describe('githubOutputLines', () => {
  const report = (overrides: Partial<BumpReport> = {}): BumpReport => ({
    current: '3.1.2',
    currentCli: '3.1.2',
    stable: { version: '3.1.3', prerelease: false, imageTag: 'ghcr.io/x:v3.1.3', cliAvailable: true },
    prerelease: null,
    ...overrides,
  });

  it('emits an empty value rather than a missing key when there is no candidate', () => {
    // The workflow reads these into $GITHUB_OUTPUT and branches on emptiness, so a
    // missing key would read as an unset step output and skip silently.
    const lines = githubOutputLines(report());
    expect(lines).toContain('prerelease=');
    expect(lines).toContain('prerelease_cli=no');
    expect(lines).toContain('stable=3.1.3');
    expect(lines).toContain('stable_cli=yes');
    expect(lines).toContain('current=3.1.2');
  });

  it('flags a candidate whose CLI has not been published', () => {
    const lines = githubOutputLines(
      report({ stable: { version: '3.9.9', prerelease: false, imageTag: 'x', cliAvailable: false } }),
    );
    expect(lines).toContain('stable_cli=no');
  });

  it('never emits a value containing a newline, which would corrupt $GITHUB_OUTPUT', () => {
    for (const line of githubOutputLines(report())) expect(line).not.toContain('\n');
  });
});

describe('rewriteVersionMentions', () => {
  it('moves every spelling of the version the parity test polices', () => {
    const before = [
      "export const EOAS_PACKAGE_SPEC = 'eoas@3.1.2';",
      'deploy `ghcr.io/mercuretechnologies/xprem:v3.1.2`',
      'Railway pulls `ghcr.io/mercuretechnologies/expo-open-ota:v3.1.2`',
    ].join('\n');

    const after = rewriteVersionMentions(before, '3.1.3', '3.1.2', '3.1.2');

    expect(after).toContain("'eoas@3.1.3'");
    expect(after).toContain('xprem:v3.1.3');
    expect(after).toContain('expo-open-ota:v3.1.3');
    expect(after).not.toContain('3.1.2');
  });

  it('does not corrupt a longer version that merely starts with this one', () => {
    // A plain substring replace turns `eoas@3.1.20` into `eoas@3.1.30` while
    // rewriting 3.1.2 -> 3.1.3. Silent, and it would land in a bump PR.
    const before = 'pinned eoas@3.1.2 today, eoas@3.1.20 is unreleased';
    const after = rewriteVersionMentions(before, '3.1.3', '3.1.2', '3.1.2');

    expect(after).toContain('eoas@3.1.3 today');
    expect(after).toContain('eoas@3.1.20 is unreleased');
  });

  it('does not rewrite a prerelease of the version it is replacing', () => {
    // `xprem:v3.1.2-beta4` is a different release from `xprem:v3.1.2`.
    const before = 'xprem:v3.1.2 shipped after xprem:v3.1.2-beta4';
    const after = rewriteVersionMentions(before, '3.1.3', '3.1.2', '3.1.2');

    expect(after).toContain('xprem:v3.1.3 shipped');
    expect(after).toContain('xprem:v3.1.2-beta4');
  });

  it('leaves a bare historical version alone, which the parity test relies on', () => {
    // The parity test requires historical mentions be written as bare versions
    // precisely so they are not swept up by a bump.
    const before = 'the 3.1.2 release fixed it; we pin eoas@3.1.2';
    const after = rewriteVersionMentions(before, '3.1.3', '3.1.2', '3.1.2');

    expect(after).toContain('the 3.1.2 release fixed it');
    expect(after).toContain('eoas@3.1.3');
  });

  it('moves a prerelease version, whose hyphen must survive escaping', () => {
    const before = 'xprem:v3.2.0-beta3 and eoas@3.2.0-beta3';
    const after = rewriteVersionMentions(before, '3.2.0', '3.2.0-beta3', '3.2.0-beta3');

    expect(after).toBe('xprem:v3.2.0 and eoas@3.2.0');
  });
});
