import { describe, expect, it } from 'vitest';
import {
  buildEoasArgs,
  parseRollbackArgs,
  republishServerVersionWarning,
  validateRollbackOptions,
} from '../mobile-ota-rollback';
import { EOAS_PACKAGE_SPEC } from '../lib/eoas';

describe('parseRollbackArgs', () => {
  it('defaults to rolling the production branch back to embedded, all platforms', () => {
    expect(parseRollbackArgs([])).toEqual({ branch: 'production', platform: 'all', mode: 'embedded' });
  });

  it('parses space-separated flags', () => {
    expect(parseRollbackArgs(['--branch', 'staging', '--platform', 'ios', '--mode', 'republish'])).toEqual({
      branch: 'staging',
      platform: 'ios',
      mode: 'republish',
    });
  });

  it('parses = flag forms', () => {
    expect(parseRollbackArgs(['--branch=staging', '--platform=android', '--mode=republish'])).toEqual({
      branch: 'staging',
      platform: 'android',
      mode: 'republish',
    });
  });
});

describe('buildEoasArgs', () => {
  it('maps the embedded mode to `eoas rollback --nonInteractive` (non-TTY safe)', () => {
    expect(buildEoasArgs({ branch: 'production', platform: 'all', mode: 'embedded' })).toEqual([
      EOAS_PACKAGE_SPEC,
      'rollback',
      '--branch',
      'production',
      '--platform',
      'all',
      '--nonInteractive',
    ]);
  });

  it('maps the republish mode to `eoas republish`', () => {
    expect(buildEoasArgs({ branch: 'production', platform: 'ios', mode: 'republish' })).toEqual([
      EOAS_PACKAGE_SPEC,
      'republish',
      '--branch',
      'production',
      '--platform',
      'ios',
    ]);
  });
});

describe('validateRollbackOptions', () => {
  it('accepts valid mode + platform', () => {
    expect(validateRollbackOptions({ branch: 'production', platform: 'all', mode: 'embedded' })).toBeNull();
  });

  it('rejects an invalid mode', () => {
    expect(validateRollbackOptions({ branch: 'production', platform: 'all', mode: 'bogus' as never })).toContain(
      '--mode',
    );
  });

  it('rejects an invalid platform', () => {
    expect(validateRollbackOptions({ branch: 'production', platform: 'web', mode: 'embedded' })).toContain(
      '--platform',
    );
  });
});

describe('republishServerVersionWarning', () => {
  // Warn-not-block is the deliberate choice (see the helper's comment), so the only
  // thing standing between a mid-incident 404 and an explained one is this text.
  it('names the server image that matches the pinned CLI', () => {
    const version = EOAS_PACKAGE_SPEC.replace(/^eoas@/, '');

    expect(republishServerVersionWarning().join('\n')).toContain(`xprem:v${version}`);
  });

  it('points at the fallback mode that still works on the older server', () => {
    expect(republishServerVersionWarning().join('\n')).toContain('--mode embedded');
  });
});
