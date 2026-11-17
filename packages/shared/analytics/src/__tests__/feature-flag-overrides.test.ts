import { describe, expect, it } from 'vitest';
import { parseFeatureFlagOverrides } from '../feature-flag-overrides';

describe('parseFeatureFlagOverrides', () => {
  it('reads the bare-key form as ON', () => {
    expect(parseFeatureFlagOverrides('some-server-flag')).toEqual({ 'some-server-flag': true });
  });

  it('reads the key=value form in both directions', () => {
    expect(parseFeatureFlagOverrides('some-server-flag=true,gym-kiosk=false')).toEqual({
      'some-server-flag': true,
      'gym-kiosk': false,
    });
  });

  it('ignores blank entries and unparseable values instead of throwing', () => {
    expect(parseFeatureFlagOverrides(' , some-server-flag = ON ,broken=maybe,=true')).toEqual({
      'some-server-flag': true,
    });
  });

  it('returns nothing for an unset variable', () => {
    expect(parseFeatureFlagOverrides(undefined)).toEqual({});
    expect(parseFeatureFlagOverrides('')).toEqual({});
  });
});
