import { describe, expect, it } from 'vitest';

import { parseAcceptedBuilds } from '../mobile-cut-release-tags';

describe('parseAcceptedBuilds', () => {
  it('parses a JSON array of version/build pairs', () => {
    expect(
      parseAcceptedBuilds('[{"versionString":"2.1.0","buildNumber":42},{"versionString":"2.0.9","buildNumber":null}]'),
    ).toEqual([
      { versionString: '2.1.0', buildNumber: 42 },
      { versionString: '2.0.9', buildNumber: null },
    ]);
  });

  it('coerces a missing or non-number buildNumber to null', () => {
    expect(parseAcceptedBuilds('[{"versionString":"3.0.0"},{"versionString":"3.0.1","buildNumber":"7"}]')).toEqual([
      { versionString: '3.0.0', buildNumber: null },
      { versionString: '3.0.1', buildNumber: null },
    ]);
  });

  it('returns [] for empty, whitespace, or undefined input', () => {
    expect(parseAcceptedBuilds(undefined)).toEqual([]);
    expect(parseAcceptedBuilds('')).toEqual([]);
    expect(parseAcceptedBuilds('   ')).toEqual([]);
  });

  it('handles the empty-array sentinel', () => {
    expect(parseAcceptedBuilds('[]')).toEqual([]);
  });

  it('throws on non-array JSON', () => {
    expect(() => parseAcceptedBuilds('{"versionString":"2.1.0"}')).toThrow(/must be a JSON array/);
  });

  it('throws when an entry lacks a versionString', () => {
    expect(() => parseAcceptedBuilds('[{"buildNumber":42}]')).toThrow(/Bad accepted-build entry/);
  });
});
