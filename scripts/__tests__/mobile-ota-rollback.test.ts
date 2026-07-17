import { describe, expect, it } from 'vitest';
import {
  buildEoasArgs,
  buildPtyWrapperArgs,
  needsPtyWorkaround,
  parseRollbackArgs,
  shellQuote,
  validateRollbackOptions,
} from '../mobile-ota-rollback';

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
  it('maps the embedded mode to `eoas rollback`', () => {
    expect(buildEoasArgs({ branch: 'production', platform: 'all', mode: 'embedded' })).toEqual([
      'eoas@2',
      'rollback',
      '--branch',
      'production',
      '--platform',
      'all',
    ]);
  });

  it('maps the republish mode to `eoas republish`', () => {
    expect(buildEoasArgs({ branch: 'production', platform: 'ios', mode: 'republish' })).toEqual([
      'eoas@2',
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

describe('needsPtyWorkaround', () => {
  it('kicks in for embedded mode with no TTY (the CI case)', () => {
    expect(needsPtyWorkaround('embedded', false)).toBe(true);
    expect(needsPtyWorkaround('embedded', undefined)).toBe(true);
  });

  it('stays off for embedded mode with a real TTY (a human can answer the prompt)', () => {
    expect(needsPtyWorkaround('embedded', true)).toBe(false);
  });

  it('never kicks in for republish — its picker needs a real terminal regardless', () => {
    expect(needsPtyWorkaround('republish', false)).toBe(false);
    expect(needsPtyWorkaround('republish', true)).toBe(false);
  });
});

describe('shellQuote', () => {
  it('wraps a plain value in single quotes', () => {
    expect(shellQuote('production')).toBe("'production'");
  });

  it('escapes embedded single quotes POSIX-style', () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });
});

describe('buildPtyWrapperArgs', () => {
  it('wraps the command with script -qec so the child sees a TTY, and quotes every arg', () => {
    expect(buildPtyWrapperArgs(['bunx', 'eoas@2', 'rollback', '--branch', 'production'])).toEqual({
      command: 'script',
      args: ['-qec', "'bunx' 'eoas@2' 'rollback' '--branch' 'production'", '/dev/null'],
    });
  });

  it('safely quotes a branch name containing a single quote', () => {
    const { args } = buildPtyWrapperArgs(['bunx', 'eoas@2', 'rollback', '--branch', "pr's-branch"]);
    expect(args[1]).toContain("'pr'\\''s-branch'");
  });
});
