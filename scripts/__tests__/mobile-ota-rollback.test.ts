import { describe, expect, it } from 'vitest';
import { buildEoasArgs, parseRollbackArgs, validateRollbackOptions } from '../mobile-ota-rollback';
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
