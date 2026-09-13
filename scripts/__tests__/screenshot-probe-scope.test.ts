/// <reference types="node" />

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  PROBE_SCOPE_RULES,
  decideProbeScope,
  decideProbeScopeForUnreachableBaseline,
  parseProbeScopeArguments,
  writeGithubOutput,
} from '../screenshot-probe-scope';

/**
 * The iOS screenshot probe shoots exactly one shard (en-US x iPhone 16 Pro
 * Max), so it is structurally blind to a change confined to another locale or
 * to an iPad-only layout. decideProbeScope is the fallback signal for that
 * blind spot — every documented rule gets its own case here so a rule that
 * silently regressed (or one accidentally removed) fails a specific test.
 */

describe('decideProbeScope', () => {
  it('does not force when nothing changed', () => {
    expect(decideProbeScope([]).forceFull).toBe(false);
  });

  it('does not force on an unrelated file', () => {
    const decision = decideProbeScope(['packages/mobile/src/components/board-view.tsx']);
    expect(decision.forceFull).toBe(false);
  });

  it('does not force on an en-US-only locale change', () => {
    const decision = decideProbeScope(['packages/shared/i18n/locales/en-US/common.json']);
    expect(decision.forceFull).toBe(false);
  });

  it('forces on a non-en-US shared i18n locale change', () => {
    const decision = decideProbeScope(['packages/shared/i18n/locales/es/common.json']);
    expect(decision.forceFull).toBe(true);
    expect(decision.reason).toContain('packages/shared/i18n/locales/es/common.json');
    expect(decision.reason).toContain('non-en-US shared i18n catalog');
  });

  it('forces on a mobile locales change', () => {
    const decision = decideProbeScope(['packages/mobile/locales/fr.json']);
    expect(decision.forceFull).toBe(true);
    expect(decision.reason).toContain('mobile locale resource');
  });

  it('forces on an iPad-specific mobile path, case-insensitively', () => {
    expect(decideProbeScope(['packages/mobile/src/components/iPadLayout.tsx']).forceFull).toBe(true);
    expect(decideProbeScope(['packages/mobile/src/components/TabletShell.tsx']).forceFull).toBe(true);
  });

  it('does not force on an ipad-looking path outside packages/mobile', () => {
    expect(decideProbeScope(['docs/ipad-on-the-wall-tab.md']).forceFull).toBe(false);
  });

  it('forces on the native app config', () => {
    const decision = decideProbeScope(['packages/mobile/app.config.ts']);
    expect(decision.forceFull).toBe(true);
    expect(decision.reason).toContain('native app config');
  });

  it('does not force on an unrelated mobile config file', () => {
    expect(decideProbeScope(['packages/mobile/metro.config.js']).forceFull).toBe(false);
  });

  it('forces on App Store metadata changes', () => {
    const decision = decideProbeScope(['app-stores/apple/metadata/en-US/description.txt']);
    expect(decision.forceFull).toBe(true);
    expect(decision.reason).toContain('App Store metadata');
  });

  it('reports the first matching rule when several files change', () => {
    const decision = decideProbeScope([
      'packages/mobile/src/components/board-view.tsx',
      'packages/shared/i18n/locales/de/common.json',
    ]);
    expect(decision.forceFull).toBe(true);
    expect(decision.reason).toContain('packages/shared/i18n/locales/de/common.json');
  });

  it('covers exactly the five documented rules', () => {
    expect(PROBE_SCOPE_RULES.map((rule) => rule.name)).toEqual([
      'shared-i18n-non-en-us-locale',
      'mobile-locales',
      'mobile-ipad-tablet',
      'mobile-app-config',
      'app-store-metadata',
    ]);
  });
});

describe('decideProbeScopeForUnreachableBaseline', () => {
  it('always forces full and names the reason', () => {
    const decision = decideProbeScopeForUnreachableBaseline('commit not found in history');
    expect(decision.forceFull).toBe(true);
    expect(decision.reason).toContain('commit not found in history');
  });
});

describe('parseProbeScopeArguments', () => {
  it('accepts --changed-files-file', () => {
    expect(parseProbeScopeArguments(['--changed-files-file', '/tmp/diff.txt'])).toEqual({
      changedFilesFile: '/tmp/diff.txt',
      unreachableBaseline: null,
    });
  });

  it('accepts --unreachable-baseline', () => {
    expect(parseProbeScopeArguments(['--unreachable-baseline', 'shallow clone'])).toEqual({
      changedFilesFile: null,
      unreachableBaseline: 'shallow clone',
    });
  });

  it('requires one of the two flags', () => {
    expect(() => parseProbeScopeArguments([])).toThrow(/either --changed-files-file/);
  });

  it('rejects an unknown flag', () => {
    expect(() => parseProbeScopeArguments(['--bogus', 'x'])).toThrow(/Unknown argument/);
  });
});

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'screenshot-probe-scope-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('writeGithubOutput', () => {
  it('writes force_full and a single-line reason', () => {
    const outputFile = join(workDir, 'github-output');
    writeFileSync(outputFile, '');
    writeGithubOutput(outputFile, { forceFull: true, reason: 'es/common.json matches a locale rule' });
    const written = readFileSync(outputFile, 'utf8');
    expect(written).toBe('force_full=true\nreason=es/common.json matches a locale rule\n');
  });

  it('flattens a multi-line reason to keep the output file line-safe', () => {
    const outputFile = join(workDir, 'github-output');
    writeFileSync(outputFile, '');
    writeGithubOutput(outputFile, { forceFull: false, reason: 'line one\nline two' });
    expect(readFileSync(outputFile, 'utf8')).toBe('force_full=false\nreason=line one line two\n');
  });
});
