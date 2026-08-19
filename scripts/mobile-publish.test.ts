/// <reference types="node" />

import { describe, expect, it } from 'vitest';
import { EOAS_PACKAGE_SPEC, SELF_HOSTED_UPLOAD_RATE_PER_SECOND } from './lib/eoas';
import { buildEasUpdateArgs, buildSelfHostedEoasArgs, parseArgs, requestedSelfHostedPlatforms } from './mobile-publish';

describe('mobile publish argument routing', () => {
  it('maps the wrapper channel selector to an eoas branch without a deprecated channel flag', () => {
    const args = buildSelfHostedEoasArgs('production', 'ios', 'fix the queue');

    expect(args).toEqual([
      EOAS_PACKAGE_SPEC,
      'publish',
      '--branch',
      'production',
      '--platform',
      'ios',
      '--message',
      'fix the queue',
      '--dumpSourcemap',
      '--outputDir',
      'dist',
      '--upload-rate',
      String(SELF_HOSTED_UPLOAD_RATE_PER_SECOND),
      '--nonInteractive',
      '--packageRunner',
      'bunx',
    ]);
    expect(args).not.toContain('--channel');
  });

  // The per-PR previews are the concurrent publishes, so they are the ones that
  // most need the rate cap — a production-only flag would miss the burst source.
  it('paces asset uploads on a per-PR preview branch too, not just production', () => {
    const args = buildSelfHostedEoasArgs('pr-1234', 'android', 'preview build');

    const flagIndex = args.indexOf('--upload-rate');
    expect(flagIndex).toBeGreaterThan(-1);
    const rate = Number(args[flagIndex + 1]);
    expect(Number.isFinite(rate)).toBe(true);
    expect(rate).toBeGreaterThan(0);
    // eoas exits 1 on a non-positive/non-numeric rate, so the constant itself has
    // to satisfy the CLI's own validation.
    expect(rate).toBe(SELF_HOSTED_UPLOAD_RATE_PER_SECOND);
    // Source maps stay production-only; the rate cap is not part of that pair.
    expect(args).not.toContain('--dumpSourcemap');
  });

  it('keeps the EAS preview command arguments unchanged', () => {
    const args = buildEasUpdateArgs('fix-branch', 'preview message', 'all');

    expect(args).toEqual([
      'eas-cli@16',
      'update',
      '--branch',
      'fix-branch',
      '--message',
      'preview message',
      '--platform',
      'all',
      '--non-interactive',
    ]);
    // `eas update` has no --upload-rate; passing one would abort the EAS path.
    expect(args).not.toContain('--upload-rate');
  });

  it('expands all to sequential iOS and Android targets', () => {
    expect(requestedSelfHostedPlatforms('all')).toEqual(['ios', 'android']);
    expect(requestedSelfHostedPlatforms('ios')).toEqual(['ios']);
    expect(requestedSelfHostedPlatforms('android')).toEqual(['android']);
  });

  it('rejects an invalid self-hosted platform at the exported helper boundary', () => {
    expect(() => requestedSelfHostedPlatforms('windows')).toThrow('Unsupported self-hosted publish platform');
  });

  it('parses the wrapper selector separately from the EAS branch', () => {
    expect(parseArgs(['--channel', 'production', '--platform=ios', '--message', 'release'])).toEqual({
      branch: null,
      channel: 'production',
      message: 'release',
      platform: 'ios',
    });
  });
});
