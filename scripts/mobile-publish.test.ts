/// <reference types="node" />

import { describe, expect, it } from 'vitest';
import { EOAS_PACKAGE_SPEC } from './lib/eoas';
import {
  buildEasUpdateArgs,
  buildSelfHostedEoasArgs,
  parseArgs,
  requestedSelfHostedPlatforms,
  selfHostedPublishModeLabel,
  selfHostedPublishSuccessMessages,
} from './mobile-publish';

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
      '--nonInteractive',
      '--packageRunner',
      'bunx',
    ]);
    expect(args).not.toContain('--channel');
  });

  it('keeps the EAS preview command arguments unchanged', () => {
    expect(buildEasUpdateArgs('fix-branch', 'preview message', 'all')).toEqual([
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

  it('describes production delivery without calling the branch a baked channel', () => {
    expect(selfHostedPublishSuccessMessages('production')).toEqual([
      '[mobile:publish] Published every requested platform to self-hosted branch "production".',
      '[mobile:publish] Production builds receive it on their next update check.',
    ]);
  });

  it('tells preview publishers to select the branch through xprem', () => {
    expect(selfHostedPublishSuccessMessages('pr-1234')).toEqual([
      '[mobile:publish] Published every requested platform to self-hosted branch "pr-1234".',
      '[mobile:publish] Select "pr-1234" in xprem Branch Surfing to load this preview.',
    ]);
  });

  it('labels self-hosted production and preview modes accurately', () => {
    expect(selfHostedPublishModeLabel('production')).toBe('production (self-hosted expo-open-ota)');
    expect(selfHostedPublishModeLabel('pr-1234')).toBe('preview (self-hosted expo-open-ota)');
  });
});
